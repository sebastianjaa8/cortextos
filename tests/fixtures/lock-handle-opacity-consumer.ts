import { HELD_LOCKS, readMetadata, installFreshLock, publishLock } from '../../src/utils/lock';

// The fork's lock fences ownership with a module-private owner token
// (HELD_LOCKS) and on-disk metadata. These are exactly the internals a caller
// would need to forge ownership of a successor's lock or rewrite a stale claim;
// the opacity test compiles this fixture and requires every import to remain a
// missing-export diagnostic.
void HELD_LOCKS;
void readMetadata;
void installFreshLock;
void publishLock;
