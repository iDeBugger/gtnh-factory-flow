/**
 * Dataset versions never offered in the picker, loaded for a plan or prewarmed
 * by the server, even if a manifest still lists them. 2.8.4 is no longer
 * supported; 2.9 and 2.8.1 are. Client and server both read this set.
 */
export const HIDDEN_DATASET_VERSION_IDS: ReadonlySet<string> = new Set(["local-2.8.4"]);
