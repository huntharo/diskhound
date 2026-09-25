import type { DevBranch } from "../../shared/contracts";
import { splitForMiddleEllipsis } from "./middleEllipsis";

/** Most characters kept whole at the end of an elided branch name. */
export const DEV_BRANCH_TAIL_CHARS = 8;
/** Leading characters still shown, before the "…", at the narrowest. */
const HEAD_CHARS = 5;

export interface DevBranchDisplay {
  /** Chip text: the branch, or `HEAD <short sha>` when detached. */
  label: string;
  /** Characters at the end of the label that never elide. */
  tailChars: number;
  /** Narrowest the label gets, in characters: a few leading ones, the
   *  "…", and the pinned tail. A short name never elides. */
  minChars: number;
  /** What a click copies: the branch, or the full commit SHA. */
  copyText: string;
  title: string;
  ariaLabel: string;
}

export function devBranchDisplay(branch: DevBranch): DevBranchDisplay {
  const label = branch.detached ? `HEAD ${branch.name.slice(0, 8)}` : branch.name;
  const { tail } = splitForMiddleEllipsis(label, DEV_BRANCH_TAIL_CHARS);
  return {
    label,
    tailChars: tail.length,
    minChars: Math.min(label.length, HEAD_CHARS + 1 + tail.length),
    copyText: branch.name,
    title: branch.detached
      ? `Detached HEAD at ${branch.name}\nClick to copy the commit`
      : `${branch.name}\nClick to copy the branch name`,
    ariaLabel: branch.detached
      ? `Copy commit ${branch.name}`
      : `Copy branch name ${branch.name}`,
  };
}
