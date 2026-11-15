import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type Reader = { getLeafId(): string | null; getEntry(id: string): SessionEntry | undefined };

/** Entry IDs identify immutable ancestry, including repeated text and alternative branches. */
export class SessionBranch {
  readonly entries: SessionEntry[] = [];
  private positions = new Map<string, number>();
  private reader?: Reader;
  private leaf: string | null | undefined;

  /** Return the first changed position; an ordinary append only reads its new parent chain. */
  sync(reader: Reader): number {
    const leaf = reader.getLeafId();
    if (reader === this.reader && leaf === this.leaf) return this.entries.length;
    const sameSession = reader === this.reader;
    const added: SessionEntry[] = [], visited = new Set<string>();
    let id = leaf, prefix = 0;
    while (id !== null) {
      const known = sameSession ? this.positions.get(id) : undefined;
      if (known !== undefined) { prefix = known + 1; break; }
      if (visited.has(id)) throw new Error("Invalid session ancestry: cyclic parent chain.");
      visited.add(id);
      const entry = reader.getEntry(id);
      if (!entry || entry.id !== id) throw new Error("Invalid session ancestry: missing entry.");
      added.push(entry);
      id = entry.parentId;
    }
    // Validate first: a failed read must not discard the last usable branch.
    for (let i = this.entries.length - 1; i >= prefix; i--) this.positions.delete(this.entries[i].id);
    this.entries.length = prefix;
    for (let i = added.length - 1; i >= 0; i--) {
      this.positions.set(added[i].id, this.entries.length);
      this.entries.push(added[i]);
    }
    this.reader = reader;
    this.leaf = leaf;
    return prefix;
  }

  clear(): void {
    this.entries.length = 0;
    this.positions.clear();
    this.reader = undefined;
    this.leaf = undefined;
  }
}
