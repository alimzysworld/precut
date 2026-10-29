export { gradeForPiece, lookParameters } from "../../../../shared/grade-math";
import type { CutVersion, DraftTimeline, Grade, PieceLook } from '../../../../shared/schema';
export type UniformTimeline = DraftTimeline & { uniformBalances?: CutVersion["balances"]; correctionKey?: number; uniformGrade?: Grade; uniformPieceLooks?: (PieceLook | null | undefined)[] };
