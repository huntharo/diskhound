/** Names used in UI copy; Linux file managers vary by desktop environment. */
export function platformTerminology(platform: string) {
  return {
    fileManager: platform === "darwin" ? "Finder" : platform === "win32" ? "Explorer" : "file manager",
    trash: platform === "win32" ? "Recycle Bin" : "Trash",
    modifier: platform === "darwin" ? "⌘" : "Ctrl",
  };
}
