/**
 * The database's row types, generated from the migrations by
 * tools/db/generate-types.ts. Never edit by hand: change the SQL, then run
 * `npm run db:types` (db/schema.test.ts fails while this file is stale).
 */
import type { ColumnType, Generated, GeneratedAlways } from "kysely";
import type { JsonParam } from "./parsers";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface BlueprintVotesTable {
  blueprint_id: string;
  voter_key: string;
  value: number;
  created_at: Generated<string>;
}

export interface BlueprintsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  payload: ColumnType<JsonValue, JsonParam, JsonParam>;
  node_count: Generated<number>;
  storage_count: Generated<number>;
  edge_count: Generated<number>;
  pocket_count: Generated<number>;
  machine_count: Generated<number>;
  is_public: Generated<boolean>;
  description: Generated<string>;
  author_name: Generated<string>;
  published_at: string | null;
  needs: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  outputs: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  tags: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  tags_text: Generated<string>;
  upvotes: Generated<number>;
  downvotes: Generated<number>;
  score: GeneratedAlways<number | null>;
  downloads: Generated<number>;
  created_at: Generated<string>;
  icon: ColumnType<JsonValue | null, JsonParam | null, JsonParam | null>;
  highest_tier: string | null;
  highest_tier_index: Generated<number>;
}

export interface CommunityCommentsTable {
  id: Generated<string>;
  plan_id: string;
  user_id: string;
  author_name: Generated<string>;
  body: string;
  created_at: Generated<string>;
  deleted_at: string | null;
}

export interface CommunityEventsTable {
  id: GeneratedAlways<number>;
  actor_key: string;
  action: string;
  created_at: Generated<string>;
}

export interface CommunityPlansTable {
  id: Generated<string>;
  name: string;
  description: Generated<string>;
  game_version: Generated<string>;
  dataset_version: Generated<string>;
  plan: ColumnType<JsonValue, JsonParam, JsonParam>;
  thumbnail_data_url: string | null;
  needs: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  outputs: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  total_eu_t: Generated<number>;
  machine_count: Generated<number>;
  node_count: Generated<number>;
  storage_count: Generated<number>;
  edge_count: Generated<number>;
  highest_tier: string | null;
  highest_tier_index: Generated<number>;
  upvotes: Generated<number>;
  downvotes: Generated<number>;
  score: GeneratedAlways<number | null>;
  downloads: Generated<number>;
  views: Generated<number>;
  uploader_key: string;
  user_id: string | null;
  author_name: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  tags: ColumnType<JsonValue, JsonParam | undefined, JsonParam>;
  tags_text: Generated<string>;
  is_public: Generated<boolean>;
  icon: ColumnType<JsonValue | null, JsonParam | null, JsonParam | null>;
  stats_version: Generated<string>;
  comment_count: Generated<number>;
  last_comment_at: string | null;
  last_activity_at: string | null;
}

export interface CommunityUsersTable {
  id: Generated<string>;
  username: string;
  password_hash: string;
  is_admin: Generated<boolean>;
  created_at: Generated<string>;
  session_epoch: Generated<number>;
}

export interface CommunityVotesTable {
  plan_id: string;
  voter_key: string;
  value: number;
  created_at: Generated<string>;
}

export interface LibraryDesignMembersTable {
  owner_id: string;
  design_id: string;
  member_id: string;
  role: Generated<string>;
  added_at: Generated<string>;
}

export interface LibraryDesignsTable {
  user_id: string;
  id: string;
  name: string;
  plan: ColumnType<JsonValue, JsonParam, JsonParam>;
  icon: ColumnType<JsonValue | null, JsonParam | null, JsonParam | null>;
  folder_id: string | null;
  closed: Generated<boolean>;
  sort_order: number | null;
  community_plan_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  plan_updated_at: Generated<string>;
  deleted_at: string | null;
  favorite: Generated<boolean>;
  seq: Generated<number>;
  live_lease_until: string | null;
  live_lease_token: string | null;
  plan_bytes: GeneratedAlways<number | null>;
}

export interface LibraryFoldersTable {
  user_id: string;
  id: string;
  name: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface Database {
  blueprint_votes: BlueprintVotesTable;
  blueprints: BlueprintsTable;
  community_comments: CommunityCommentsTable;
  community_events: CommunityEventsTable;
  community_plans: CommunityPlansTable;
  community_users: CommunityUsersTable;
  community_votes: CommunityVotesTable;
  library_design_members: LibraryDesignMembersTable;
  library_designs: LibraryDesignsTable;
  library_folders: LibraryFoldersTable;
}
