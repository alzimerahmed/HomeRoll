import type { AlbumResponseDto } from '@immich/sdk';
import { sortAlbums } from '$lib/utils/album-utils';

/**
 * Group-by option value for the nested album hierarchy (FG-07). The constant
 * lives in `album-utils.ts` (which owns the grouping metadata) and is
 * re-exported here so tree consumers keep a single import site.
 */
export { ALBUM_FOLDER_GROUP } from '$lib/utils/album-utils';

/** Mirrors MAX_ALBUM_DEPTH in `server/src/services/album.service.ts`. */
export const MAX_ALBUM_DEPTH = 10;

export interface AlbumTreeNode {
  album: AlbumResponseDto;
  children: AlbumTreeNode[];
}

/**
 * Builds a forest of album nodes from a flat list. Albums whose parent is not
 * part of the list (filtered out, or owned by another user) are treated as
 * roots. Cyclic structures — which the server already rejects — are broken by
 * promoting unreachable nodes to roots so nothing disappears from the UI.
 */
export const buildAlbumTree = (albums: AlbumResponseDto[]): AlbumTreeNode[] => {
  const nodes = new Map<string, AlbumTreeNode>();
  for (const album of albums) {
    nodes.set(album.id, { album, children: [] });
  }

  const roots: AlbumTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.album.parentId ? nodes.get(node.album.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const reachable = new Set<string>();
  const visit = (node: AlbumTreeNode) => {
    if (reachable.has(node.album.id)) {
      return;
    }
    reachable.add(node.album.id);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  for (const node of nodes.values()) {
    if (!reachable.has(node.album.id)) {
      roots.push(node);
      visit(node);
    }
  }

  return roots;
};

/**
 * Sorts every level of an album tree with the albums-view sort settings.
 */
export const sortAlbumTree = (nodes: AlbumTreeNode[], sortBy: string, orderBy: string): AlbumTreeNode[] => {
  const order = new Map(sortAlbums(nodes.map(({ album }) => album), { sortBy, orderBy }).map(({ id }, index) => [id, index]));
  return nodes
    .slice()
    .sort((a, b) => (order.get(a.album.id) ?? 0) - (order.get(b.album.id) ?? 0))
    .map((node) => ({ ...node, children: sortAlbumTree(node.children, sortBy, orderBy) }));
};

export interface AlbumTreeView {
  roots: AlbumTreeNode[];
  /**
   * IDs of nodes rendered only for structural context (ancestors of matching
   * albums when a search filter is active). They are displayed dimmed.
   */
  contextIds: Set<string>;
}

/**
 * Builds the tree restricted to `visibleAlbums` (e.g. after a search filter),
 * keeping the ancestors of every visible album so the hierarchy stays readable.
 */
export const buildAlbumTreeView = (allAlbums: AlbumResponseDto[], visibleAlbums: AlbumResponseDto[]): AlbumTreeView => {
  const visibleIds = new Set(visibleAlbums.map(({ id }) => id));
  const contextIds = new Set<string>();

  const prune = (node: AlbumTreeNode): AlbumTreeNode | undefined => {
    const children = node.children.map(prune).filter((child): child is AlbumTreeNode => child !== undefined);
    if (visibleIds.has(node.album.id)) {
      return { ...node, children };
    }
    if (children.length > 0) {
      contextIds.add(node.album.id);
      return { ...node, children };
    }
    return undefined;
  };

  const roots = buildAlbumTree(allAlbums).map(prune).filter((node): node is AlbumTreeNode => node !== undefined);
  return { roots, contextIds };
};

/**
 * Returns the IDs of every album below `albumId` in the hierarchy (children,
 * grandchildren, …). Used to exclude impossible reparent targets — the server
 * also rejects cycles, this only drives the picker's option list.
 */
export const getAlbumDescendantIds = (albumId: string, albums: AlbumResponseDto[]): Set<string> => {
  const childrenByParentId = new Map<string, string[]>();
  for (const album of albums) {
    if (!album.parentId) {
      continue;
    }
    const children = childrenByParentId.get(album.parentId) ?? [];
    children.push(album.id);
    childrenByParentId.set(album.parentId, children);
  }

  const descendants = new Set<string>();
  const stack = [...(childrenByParentId.get(albumId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (descendants.has(id)) {
      continue;
    }
    descendants.add(id);
    stack.push(...(childrenByParentId.get(id) ?? []));
  }
  return descendants;
};

/**
 * Returns the ancestor chain of an album, root-first, as far as it can be
 * resolved from `albums`. Missing ancestors (inaccessible albums) end the chain.
 */
export const getAlbumAncestors = (album: AlbumResponseDto, albums: AlbumResponseDto[]): AlbumResponseDto[] => {
  const byId = new Map(albums.map((entry) => [entry.id, entry]));
  const ancestors: AlbumResponseDto[] = [];
  const seen = new Set([album.id]);

  let current: AlbumResponseDto | undefined = album;
  while (current?.parentId && !seen.has(current.parentId)) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      break;
    }
    ancestors.unshift(parent);
    seen.add(parent.id);
    current = parent;
  }

  return ancestors;
};
