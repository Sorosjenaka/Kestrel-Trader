import { parentPort, threadId, workerData } from "node:worker_threads";
if (workerData.action === "throw") throw new Error("OFFLINE_WORKER_FAILURE");
if (workerData.action === "delay") await new Promise(resolve => setTimeout(resolve, 30000));
if (workerData.action !== "empty") parentPort?.postMessage({ threadId, value: workerData.value });
