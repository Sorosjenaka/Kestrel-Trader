import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

export async function linkDirectionBattleToPosition(battleId: string | null, positionId: number): Promise<void> {
  if (!battleId || !Number.isFinite(positionId)) return;
  try {
    await db.directionBattle.update({ where: { battleId }, data: { positionId } });
  } catch (err) {
    logger.error({ battleId, positionId, err: err instanceof Error ? err.message : String(err) }, "DIRECTION_BATTLE_POSITION_LINK_FAIL");
  }
}

export async function updateClosedDirectionBattle(positionId: number): Promise<void> {
  if (!Number.isFinite(positionId)) return;
  try {
    const position = await db.position.findUnique({
      where: { id: positionId },
      select: { id: true, side: true, status: true, pnlUsd: true, pnlR: true, closeReason: true, closedAt: true },
    });
    if (!position || position.status !== "CLOSED" || !position.closedAt) return;
    const battles = await db.directionBattle.findMany({ where: { positionId, outcomeStatus: "PENDING" } });
    for (const battle of battles) {
      await db.directionBattle.update({
        where: { id: battle.id },
        data: {
          outcomeStatus: "CLOSED",
          realizedPnlUsd: position.pnlUsd,
          realizedR: position.pnlR,
          closeReason: position.closeReason,
          directionCorrect: battle.winner === position.side,
          outcomeAt: position.closedAt,
        },
      });
    }
  } catch (err) {
    logger.error({ positionId, err: err instanceof Error ? err.message : String(err) }, "DIRECTION_BATTLE_OUTCOME_UPDATE_FAIL");
  }
}
