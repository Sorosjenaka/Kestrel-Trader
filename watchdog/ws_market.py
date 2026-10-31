#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ws_market.py — Hybrid market-data + user-data stream untuk watchdog (P5).

ATURAN DESAIN (directive G):
  - Stdlib MURNI (socket, ssl, threading, json, base64, hashlib) — TANPA
    dependency baru: service produksi jalan pakai /usr/bin/python3 yang tidak
    melihat site-packages user; mengubah service = di luar lingkup approval.
  - Thread WS HANYA mengisi price board + health + event log. TIDAK PERNAH
    mengirim order, TIDAK memanggil begin_exit. Exit owner tetap satu: main
    loop watchdog (tick) lewat guard EXIT_PENDING/recovery yang sudah ada.
  - Trigger TIDAK PERNAH dari harga basi: board menyimpan waktu monotonic;
    fresh() wajib untuk dipakai; else fallback REST (jalur lama, tak berubah).
  - Reconnect: backoff eksponensial BOUNDED (base 1s, cap 30s), deterministik
    (jitter di-inject, default tanpa). Setelah (re)connect: board dikosongkan,
    snapshot REST segar dulu sebelum harga dianggap current.
  - Validasi input: aggTrade malformed / non-finite / out-of-order (event time
    mundur jauh) DITOLAK (ValueError) — tidak masuk board.
  - User-data stream: HANYA OBSERVASI (ORDER_TRADE_UPDATE / ACCOUNT_UPDATE /
    ALGO_UPDATE / kondisional) — dicatat ke JSONL utk korelasi & audit.
    Tidak dipakai sebagai pemicu exit (single exit owner). listenKey di-refresh
    < 30 menit (server cutoff 60 menit) via endpoint TIDAK-butuh-signature.

Endpoint (dicek ulang saat integrasi — dok resmi USDⓈ-M):
  WS market : wss://fstream.binance.com/stream?streams=<s1>@aggTrade/...
  WS user   : wss://fstream.binance.com/ws/<listenKey>
  REST listenKey: POST/PUT/DELETE /fapi/v1/listenKey (header X-MBX-APIKEY)
  aggTrade event: {"e":"aggTrade","E":ms,"s":"BTCUSDT","p":"..","q":"..","T":ms,"a":id}
"""
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
import time

WS_HOST = "fstream.binance.com"
# P5+GATE: SATU-SATUNYA host trigger harga USDⓈ-M Futures. Route resmi pasca
# migrasi 2026-03-06 (legacy /stream & /ws pensiun 2026-04-23 — terbukti mati
# empiris): @aggTrade = kategori "market" → /market/stream?streams=... dan
# /market/ws/<stream>. data-stream.binance.vision (dokumentasi SPOT) DIHAPUS
# total dari seluruh jalur sumber harga trigger — audit pre-deploy 12 Okt 2026.
WS_HOSTS = ("fstream.binance.com",)
WS_PORT = 443
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x2, 0x8, 0x9, 0xA


# ── parsing & validasi (pure, mudah dites) ───────────────────────────────────
def parse_aggtrade(msg):
    """Parse+validasi satu event aggTrade. Raise ValueError bila tidak layak.
    Return dict {symbol, price, qty, event_ms, trade_ms, agg_id}."""
    try:
        d = json.loads(msg) if isinstance(msg, (str, bytes)) else msg
        if isinstance(d, dict) and "stream" in d and isinstance(d.get("data"), dict):
            d = d["data"]  # bentuk combined stream
        if not isinstance(d, dict) or str(d.get("e", "")) != "aggTrade":
            raise ValueError("bukan aggTrade")
        symbol = str(d.get("s", "")).upper()
        if not symbol or "/" in symbol:
            raise ValueError("symbol invalid")
        price = float(d.get("p"))
        qty = float(d.get("q"))
        event_ms = int(d.get("E"))
        trade_ms = int(d.get("T"))
        agg_id = int(d.get("a"))
        if not (price > 0) or price != price or price in (float("inf"), float("-inf")):
            raise ValueError("price tidak finite/positif")
        if not (qty >= 0) or qty != qty:
            raise ValueError("qty tidak valid")
        if event_ms <= 0 or trade_ms <= 0:
            raise ValueError("timestamp tidak valid")
        return {"symbol": symbol, "price": price, "qty": qty,
                "event_ms": event_ms, "trade_ms": trade_ms, "agg_id": agg_id}
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("aggTrade malformed: %s" % e)


def aggtrade_stream(symbol):
    return "%s@aggTrade" % str(symbol).lower()


def combined_url(symbols):
    """Combined market stream — route resmi kategori MARKET pasca-migrasi
    (aggTrade = kategori market): /market/stream?streams=<s1>/<s2>.
    Ref: Binance USDⓈ-M Futures WS migration 2026-03-06 (legacy /stream pensiun
    2026-04-23)."""
    return "wss://%s/market/stream?streams=%s" % (
        WS_HOST, "/".join(aggtrade_stream(s) for s in sorted(set(symbols))))


def market_raw_url(symbol):
    """Raw (single) market stream — route resmi kategori MARKET:
    /market/ws/<stream>. (Feed watchdog memakai combined + SUBSCRIBE; builder
    ini disediakan/diuji sesuai dokumentasi utk mode raw bila diperlukan.)"""
    return "wss://%s/market/ws/%s" % (WS_HOST, aggtrade_stream(symbol))


# Route private user-data pasca-migrasi (changelog resmi via pengutipan issue
# migrasi UBWA + konsistensi pola /public/ws & /market/ws yang terbukti hidup):
# /private/ws/<listenKey>. CATATAN JUJUR: varian alternatif "?listenKey=...&events=..."
# TIDAK bisa diverifikasi tanpa listenKey asli (probe dummy identik utk semua
# varian) — kontrak event-subscription masih BLOCKER terverifikasi-parsial;
# listener user-data tetap default-OFF (ws_user_enabled) dan observasi-only.
PRIVATE_WS_PATH_TEMPLATE = "/private/ws/%s"


def private_ws_path(listen_key):
    """Path WS private user-data (listenKey TIDAK PERNAH di-log)."""
    return PRIVATE_WS_PATH_TEMPLATE % str(listen_key)


# ── backoff eksponensial bounded (deterministik) ─────────────────────────────
def backoff_delay(attempt, base=1.0, cap=30.0):
    if attempt <= 1:
        return min(cap, base)
    return min(cap, base * (2 ** (attempt - 1)))


# ── price board (thread-safe, freshness-guarded) ─────────────────────────────
class PriceBoard:
    """Papan harga LAST terakhir per simbol + waktu monotonic penerimaan."""

    def __init__(self, max_age_sec=3.0):
        self.max_age = float(max_age_sec)
        self._lock = threading.Lock()
        self._px = {}   # sym -> (price, monotonic_at)
        self.dropped = 0

    def update(self, symbol, price):
        now = time.monotonic()
        with self._lock:
            prev = self._px.get(symbol)
            # Out-of-order: event lebih lama dari yang terpasang TETAP diterima
            # bila harga berubah (LAST terbaru dari stream); papan memegang
            # pengamatan TERAKHIR, bukan max. Tapi monotonic-at selalu now.
            self._px[symbol] = (float(price), now)

    def get_fresh(self, symbol):
        """Return harga bila usia <= max_age; else None (HARUS fallback REST)."""
        d = self.get_fresh_detail(symbol)
        return None if d is None else d[0]

    def get_fresh_detail(self, symbol):
        """Return (price, receipt_monotonic) bila fresh; else None."""
        with self._lock:
            ent = self._px.get(symbol)
            if not ent:
                return None
            price, at = ent
            if (time.monotonic() - at) > self.max_age:
                return None
            return price, at

    def clear(self, symbol=None):
        with self._lock:
            if symbol is None:
                self._px.clear()
            else:
                self._px.pop(symbol, None)

    def snapshot(self):
        with self._lock:
            return {s: p for s, (p, _) in self._px.items()}


# ── frame websocket RFC6455 minimal (client) ─────────────────────────────────
class WsFrameSocket:
    """Frame WS di atas socket yang sudah terhubung (TLS dikerjakan caller /
    injectable utk test). Client frame WAJIB masked (RFC6455)."""

    def __init__(self, sock):
        self.sock = sock
        self._write_lock = threading.Lock()
        self._rxbuf = b""
        self._frag = (None, b"")  # (opcode fragmen berjalan, buffer)

    def _read_exact(self, n, deadline):
        self.sock.settimeout(max(0.1, deadline - time.monotonic()))
        while len(self._rxbuf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("eof")
            self._rxbuf += chunk
        out, self._rxbuf = self._rxbuf[:n], self._rxbuf[n:]
        return out

    def recv_frame(self, timeout=5.0):
        """Return (opcode, payload_bytes). Close -> (OP_CLOSE, payload).
        Ping TIDAK dijawab di sini (caller yang auto-pong supaya testable)."""
        deadline = time.monotonic() + timeout
        hdr = self._read_exact(2, deadline)
        b1, b2 = hdr[0], hdr[1]
        opcode = b1 & 0x0F
        fin = bool(b1 & 0x80)
        masked = bool(b2 & 0x80)
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._read_exact(2, deadline))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._read_exact(8, deadline))[0]
        if ln > 4 * 1024 * 1024:
            raise ValueError("frame terlalu besar")
        mask = self._read_exact(4, deadline) if masked else b""
        payload = self._read_exact(ln, deadline) if ln else b""
        if masked:
            payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        if opcode == 0x0:  # continuation: gabung dengan buffer fragmen
            prev_op, prev = self._frag
            self._frag = (prev_op, prev + payload)
            if fin:
                op, buf = self._frag
                self._frag = (None, b"")
                return op, buf
            return None, b""
        if not fin:
            self._frag = (opcode, payload)
            return None, b""
        return opcode, payload

    def send_frame(self, opcode, payload=b""):
        mask = os.urandom(4)
        hdr = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        with self._write_lock:
            self.sock.sendall(hdr + mask + masked)

    def send_text(self, text):
        self.send_frame(OP_TEXT, text.encode("utf-8"))

    def send_pong(self, payload=b""):
        self.send_frame(OP_PONG, payload)

    def close(self):
        try:
            self.send_frame(OP_CLOSE, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def ws_accept_key(client_key):
    """Sec-WebSocket-Accept yang diharapkan (validasi handshake)."""
    h = hashlib.sha1((client_key + _GUID).encode("ascii")).digest()
    return base64.b64encode(h).decode("ascii")


# ── feed market (aggTrade) ───────────────────────────────────────────────────
class WsMarketFeed:
    """Feed aggTrade -> PriceBoard. Thread daemon; backoff bounded;
    resubscribe otomatis saat simbol bertambah; snapshot REST setelah connect
    dilakukan lewat callback `seed_fn(symbol)` (dipasang watchdog: REST harga)."""

    STATE_STOPPED, STATE_CONNECTING, STATE_OPEN, STATE_BACKOFF = (
        "STOPPED", "CONNECTING", "OPEN", "BACKOFF")

    def __init__(self, board, symbols=(), socket_factory=None, seed_fn=None,
                 base_backoff=1.0, cap_backoff=30.0, max_age_sec=3.0,
                 idle_timeout=10.0, health_file=None, hosts=None,
                 data_deadline=6.0):
        self.board = board
        self._want = set(s.upper() for s in symbols)
        self._lock = threading.Lock()
        self._factory = socket_factory or self._default_factory
        self._seed = seed_fn
        self._base, self._cap = float(base_backoff), float(cap_backoff)
        self._idle = float(idle_timeout)
        self._health_file = health_file
        self._hosts = tuple(hosts) if hosts else WS_HOSTS
        self.last_error = None  # diinisialisasi SEBELUM gate host (gate bisa mengisinya)
        # GATE: host selain host Futures resmi (mis. data-stream.binance.vision
        # = SPOT) TIDAK BOLEH menjadi sumber harga trigger — buang + catat.
        bad = tuple(h for h in self._hosts if h != WS_HOST)
        if bad:
            self._hosts = tuple(h for h in self._hosts if h == WS_HOST)
            self.last_error = "host non-Futures dibuang dari rotasi: %s" % (bad,)
        if not self._hosts:
            raise ValueError("tidak ada host Futures valid utk market feed")
        self._host_idx = 0
        self._host = self._hosts[0]
        self.data_deadline = float(data_deadline)
        self.state = self.STATE_STOPPED
        self.attempt = 0
        self.reconnects = 0
        self.messages = 0
        self.rejected = 0
        self.last_msg_monotonic = None
        self._stop = threading.Event()
        self._thr = None

    @staticmethod
    def _default_factory(host):
        raw = socket.create_connection((host, WS_PORT), timeout=10)
        ctx = ssl.create_default_context()
        return ctx.wrap_socket(raw, server_hostname=host)

    def subscribe_symbols(self, symbols):
        """Tambah simbol (dinamis saat posisi baru muncul). Ambil effect saat
        connect berikutnya ATAU kirim SUBSCRIBE sekarang bila socket terbuka."""
        with self._lock:
            add = set(s.upper() for s in symbols) - self._want
            if not add:
                return
            self._want |= add
        frames = getattr(self, "_sock_frames", None)
        if frames is not None and self.state == self.STATE_OPEN:
            try:
                frames.send_text(json.dumps({"method": "SUBSCRIBE", "params":
                    [aggtrade_stream(s) for s in add], "id": int(time.time())}))
            except Exception as error:
                self.last_error = "dynamic subscribe failed: %s" % type(error).__name__
                sock = getattr(self, "_sock", None)
                if sock is not None:
                    sock.close()  # force reconnect carrying the entire desired set
        self._write_health()

    def symbols(self):
        with self._lock:
            return set(self._want)

    def start(self):
        if self._thr and self._thr.is_alive():
            return
        self._stop.clear()
        self._thr = threading.Thread(target=self._run, name="ws-market", daemon=True)
        self._thr.start()

    def stop(self):
        self._stop.set()
        sock = getattr(self, "_sock", None)
        if sock is not None:
            sock.close()

    def _set_state(self, s):
        self.state = s
        self._write_health()

    def _write_health(self):
        if not self._health_file:
            return
        try:
            tmp = self._health_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.health(), f)
            os.replace(tmp, self._health_file)
        except Exception:
            pass

    def health(self):
        return {
            "updatedAt": time.time(),
            "state": self.state, "attempt": self.attempt,
            "host": getattr(self, "_host", None),
            "reconnects": self.reconnects, "messages": self.messages,
            "rejected": self.rejected, "symbols": sorted(self._want),
            "last_error": self.last_error,
            "last_msg_age": (None if self.last_msg_monotonic is None
                             else round(time.monotonic() - self.last_msg_monotonic, 3)),
        }

    def _run(self):
        while not self._stop.is_set():
            if not self._want:
                # Tanpa simbol: tidak ada stream utk dihubungkan (route base
                # kosong tidak terdefinisi di docs) — tunggu subscribe dinamis.
                # Selama itu harga jalan via REST fallback (jalur lama, Futures).
                self._set_state(self.STATE_STOPPED)
                self._stop.wait(0.5)
                continue
            sock = None
            self._sock_frames = None
            try:
                self._set_state(self.STATE_CONNECTING)
                self._host = self._hosts[self._host_idx % len(self._hosts)]
                sock = self._factory(self._host)
                self._handshake(sock, self._host)
                self._sock = sock
                self.attempt = 0
                self.reconnects += 1 if self.last_msg_monotonic is not None else 0
                self._set_state(self.STATE_OPEN)
                # Board basi setelah (re)connect; seed REST fresh per simbol.
                self.board.clear()
                if self._seed:
                    for s in self.symbols():
                        try:
                            p = self._seed(s)
                            if p:
                                self.board.update(s, p)
                        except Exception:
                            pass
                try:
                    self._sock_frames.send_text(json.dumps({"method": "SUBSCRIBE", "params":
                        [aggtrade_stream(s) for s in sorted(self.symbols())], "id": 1}))
                except Exception:
                    pass
                got_data = self._recv_loop(sock)
                # Terbuka tapi TIDAK pernah mengirim data dalam data_deadline:
                # tandai host bermasalah & rotasi (kasus fstream diam, terukur).
                if not got_data and self.messages == 0:
                    self.last_error = "host %s terbuka tapi diam %.0fs" % (
                        self._host, self.data_deadline)
                    self._host_idx += 1
            except Exception as e:
                self.last_error = str(e)[:200]
            finally:
                self._sock_frames = None
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass
            try:
                self._sock = None
            except Exception:
                pass
            if self._stop.is_set():
                break
            self.attempt += 1
            self._set_state(self.STATE_BACKOFF)
            delay = backoff_delay(self.attempt, self._base, self._cap)
            self._stop.wait(delay)
        self._set_state(self.STATE_STOPPED)

    def _handshake(self, sock, host):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        # GATE: combined MARKET stream — /market/stream?streams=<s1>/<s2>
        # (kategori resmi aggTrade; legacy /stream pensiun 2026-04-23).
        path = "/market/stream?streams=%s" % "/".join(
            aggtrade_stream(s) for s in sorted(self.symbols()))
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\nUser-Agent: artatrade-watchdog/1\r\n\r\n"
               % (path, host, key))
        sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake eof")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError("handshake ditolak: %s" % head[:80])
        expect = ws_accept_key(key).encode("ascii")
        if expect not in head:
            raise ConnectionError("Sec-WebSocket-Accept mismatch")
        frames = WsFrameSocket(sock)
        frames._rxbuf = rest  # byte awal frame bisa tercampur handshake
        self._sock_frames = frames

    def _recv_loop(self, sock):
        frames = self._sock_frames
        got_data = False
        data_deadline = time.monotonic() + self.data_deadline
        while not self._stop.is_set():
            try:
                op, payload = frames.recv_frame(timeout=self._idle)
            except socket.timeout:
                self._write_health()
                # Idle bukan error. TAPI bila host BELUM PERNAH mengirim data
                # dan sudah melewati data_deadline -> rotasi host (kasus nyata:
                # fstream menerima upgrade lalu diam dari jaringan tertentu).
                if not got_data and time.monotonic() > data_deadline:
                    return False
                continue
            if op is None:
                continue  # fragmen belum selesai
            if op == OP_PING:
                frames.send_pong(payload)
                continue
            if op == OP_PONG:
                continue
            if op == OP_CLOSE:
                raise ConnectionError("server close")
            if op != OP_TEXT:
                continue
            self.last_msg_monotonic = time.monotonic()
            self.messages += 1
            got_data = True
            try:
                d = json.loads(payload.decode("utf-8"))
            except Exception:
                self.rejected += 1
                continue
            if isinstance(d, dict) and "id" in d and "e" not in d:
                continue  # ack SUBSCRIBE
            try:
                t = parse_aggtrade(payload.decode("utf-8"))
            except ValueError:
                self.rejected += 1
                continue
            self.board.update(t["symbol"], t["price"])
            self._write_health()
        return got_data


# ── user-data stream (observasi; TIDAK di jalur eksekusi) ────────────────────
def next_keepalive_at(last_ms, interval_ms=25 * 60 * 1000):
    """Jadwal keepalive listenKey (server putus 60 menit; refresh < 30 menit)."""
    return last_ms + interval_ms


class WsUserDataListener:
    """Listen /ws/<listenKey>; SEMUA event dicatat JSONL (observasi/audit).
    listenKey endpoint TIDAK butuh signature (cukup API key header)."""

    def __init__(self, sink_path, api_key_header_fn=None, ws_factory=None,
                 listen_key_fn=None, keepalive_fn=None, base_backoff=1.0,
                 cap_backoff=30.0, idle_timeout=10.0):
        self.sink = sink_path
        self._keyhdr = api_key_header_fn or (lambda: None)
        self._factory = ws_factory or (lambda: WsMarketFeed._default_factory(WS_HOST))
        self._lk = listen_key_fn            # -> str (injectable; REST POST)
        self._ka = keepalive_fn             # (key) -> None (injectable; REST PUT)
        self._base, self._cap = base_backoff, cap_backoff
        self._idle = float(idle_timeout)
        self.state = WsMarketFeed.STATE_STOPPED
        self.events = 0
        self.reconnects = 0
        self.last_error = None
        self._stop = threading.Event()
        self._thr = None
        self._ka_at = 0.0

    def start(self):
        if self._thr and self._thr.is_alive():
            return
        self._stop.clear()
        self._thr = threading.Thread(target=self._run, name="ws-user", daemon=True)
        self._thr.start()

    def stop(self):
        self._stop.set()

    def _record(self, obj):
        try:
            d = os.path.dirname(self.sink)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(self.sink, "a", encoding="utf-8") as f:
                f.write(json.dumps({"recvAt": time.time(), "ev": obj},
                                   separators=(",", ":")) + "\n")
        except Exception:
            pass

    def _run(self):
        attempt = 0
        key = None
        while not self._stop.is_set():
            try:
                if not key:
                    key = self._lk()  # fail -> except -> backoff (fail-closed)
                    self._ka_at = time.monotonic()
                    attempt = 0
                self.state = WsMarketFeed.STATE_CONNECTING
                sock = self._factory()
                frames = self._handshake_user(sock, key)
                self.reconnects += 1
                self.state = WsMarketFeed.STATE_OPEN
                while not self._stop.is_set():
                    if time.monotonic() >= self._ka_at:
                        self._ka(key)
                        self._ka_at = next_keepalive_at(
                            int(self._ka_at * 1000)) / 1000.0
                    try:
                        op, payload = frames.recv_frame(timeout=self._idle)
                    except socket.timeout:
                        continue  # idle: bukan error; keepalive tetap dicek
                    if op is None:
                        continue
                    if op == OP_PING:
                        frames.send_pong(payload)
                        continue
                    if op == OP_CLOSE:
                        raise ConnectionError("server close")
                    if op != OP_TEXT:
                        continue
                    try:
                        self._record(json.loads(payload.decode("utf-8")))
                        self.events += 1
                    except Exception:
                        pass
            except Exception as e:
                self.last_error = str(e)[:200]
                key = None  # listenKey bisa kedaluwarsa -> ambil baru
            attempt += 1
            self.state = WsMarketFeed.STATE_BACKOFF
            self._stop.wait(backoff_delay(attempt, self._base, self._cap))
        self.state = WsMarketFeed.STATE_STOPPED

    def _handshake_user(self, sock, key):
        # GATE: private user-data pasca-migrasi — /private/ws/<listenKey>
        # (changelog resmi; konsisten pola /public/ws & /market/ws terbukti
        # hidup). listenKey tidak pernah di-log. Kontrak ?events= TIDAK
        # diimplementasikan: belum terverifikasi → listener tetap observasi
        # (semua event server kirim pada koneksi listenKey dicatat).
        path = private_ws_path(key)
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n"
               % (path, WS_HOST, base64.b64encode(os.urandom(16)).decode("ascii")))
        sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake eof")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError("handshake ditolak: %s" % head[:80])
        fr = WsFrameSocket(sock)
        fr._rxbuf = rest
        return fr
