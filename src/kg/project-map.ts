// Project -> graph-partition mapping (MikroB decision D2, card 3f6fc4ce comment 20814):
// the partition key is the kanban card's `project` field, lowercased to its canonical name --
// NOT the repo name (marveen/mopsion), which belongs in the anchor instead. A card with no
// project (NULL) has no owning partition: callers that need a single partition for such a card
// should use '_global' directly rather than guessing.

const CANONICAL: Readonly<Record<string, string>> = {
  mikrob: 'mikrob',
  mopsion: 'mopsion',
  ingatlan: 'ingatlan',
}

export const GLOBAL_PARTITION = '_global'

/** Maps a kanban card's `project` field to its graph partition. Unknown-but-present values pass
 *  through lowercased (future-proof for a project added to the board before this map is updated),
 *  rather than silently folding them into `_global` -- the MODULTERV calls `_global` the home for
 *  cross-project class nodes, not an unknown-project bucket. */
export function mapProjectToPartition(project: string | null | undefined): string {
  if (!project || !project.trim()) return GLOBAL_PARTITION
  const key = project.trim().toLowerCase()
  return CANONICAL[key] ?? key
}
