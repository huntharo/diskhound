import { HEAP_BYTES_PER_SIDECAR_LINE_BYTE } from "./folderTreeLoadPlan";
import type { FolderTreeSidecarQueryResult } from "./folderTreeSidecarQuery";
import { relativeDepth } from "./folderTreeSidecarQuery";
import type { FolderNodeRecord } from "./folderTreeWorkerProtocol";

/**
 * Bounded cache of paged folder-tree query results for scans too big to
 * hold whole (see folderTreeSidecarQuery.ts).
 *
 * One page is one query: the anchor folder plus every descendant down
 * to `coveredDepth`, and the requested folder even if it's deeper. A
 * folder inside a page's coverage but missing from its entries has no
 * sidecar line, so it's empty. Pages are evicted whole so that stays
 * true. LRU by page, bounded by the estimated heap the parsed nodes
 * take.
 */

interface Page {
  scanId: string;
  anchorKey: string;
  coveredDepth: number;
  nodes: Map<string, FolderNodeRecord>;
  heapBytes: number;
}

export const EMPTY_FOLDER_NODE: FolderNodeRecord = Object.freeze({
  dirs: [],
  files: [],
}) as FolderNodeRecord;

export class FolderTreePageCache {
  /** Least recently used first. */
  private pages: Page[] = [];
  private totalHeapBytes = 0;

  constructor(
    private readonly maxHeapBytes: number,
    private readonly separator: "/" | "\\",
  ) {}

  /** The folder's node, EMPTY_FOLDER_NODE when a page covers it with no line, or null on a miss. */
  lookup(scanId: string, key: string): FolderNodeRecord | null {
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const page = this.pages[i];
      if (page.scanId !== scanId) continue;
      let node = page.nodes.get(key);
      if (!node) {
        const depth = relativeDepth(key, page.anchorKey, this.separator);
        if (depth < 0 || depth > page.coveredDepth) continue;
        node = EMPTY_FOLDER_NODE;
      }
      if (i !== this.pages.length - 1) {
        this.pages.splice(i, 1);
        this.pages.push(page);
      }
      return node;
    }
    return null;
  }

  add(scanId: string, result: FolderTreeSidecarQueryResult): void {
    const page: Page = {
      scanId,
      anchorKey: result.anchorKey,
      coveredDepth: result.coveredDepth,
      nodes: new Map(result.entries),
      heapBytes: Math.ceil(result.bytesKept * HEAP_BYTES_PER_SIDECAR_LINE_BYTE),
    };
    this.pages.push(page);
    this.totalHeapBytes += page.heapBytes;
    // Keep the newest page even if it alone is over budget: the caller
    // is about to read from it.
    while (this.totalHeapBytes > this.maxHeapBytes && this.pages.length > 1) {
      const evicted = this.pages.shift() as Page;
      this.totalHeapBytes -= evicted.heapBytes;
    }
  }

  invalidateScan(scanId: string): void {
    this.pages = this.pages.filter((page) => {
      if (page.scanId !== scanId) return true;
      this.totalHeapBytes -= page.heapBytes;
      return false;
    });
  }

  stats(): { pages: number; nodes: number; heapBytes: number } {
    let nodes = 0;
    for (const page of this.pages) nodes += page.nodes.size;
    return { pages: this.pages.length, nodes, heapBytes: this.totalHeapBytes };
  }
}
