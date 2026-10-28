/**
 * Every route handler and the Express 5 path it answers on. The table is
 * explicit, with static imports, so nothing is discovered at run time; the
 * test derives each path from its file, so the table cannot drift from the
 * folders.
 */
import * as apiAccountsSearch from "@/server/routes/api/accounts/search/route";
import * as apiBlueprints from "@/server/routes/api/blueprints/route";
import * as apiBlueprintsBlueprintId from "@/server/routes/api/blueprints/[blueprintId]/route";
import * as apiCommunityAuthLogin from "@/server/routes/api/community/auth/login/route";
import * as apiCommunityAuthLogout from "@/server/routes/api/community/auth/logout/route";
import * as apiCommunityAuthMe from "@/server/routes/api/community/auth/me/route";
import * as apiCommunityAuthRegister from "@/server/routes/api/community/auth/register/route";
import * as apiCommunityImages from "@/server/routes/api/community/images/route";
import * as apiCommunityImagesMonthName from "@/server/routes/api/community/images/[month]/[name]/route";
import * as apiCommunityPlans from "@/server/routes/api/community/plans/route";
import * as apiCommunityPlansPlanId from "@/server/routes/api/community/plans/[planId]/route";
import * as apiCommunityPlansPlanIdComments from "@/server/routes/api/community/plans/[planId]/comments/route";
import * as apiCommunityPlansPlanIdCommentsCommentId from "@/server/routes/api/community/plans/[planId]/comments/[commentId]/route";
import * as apiCommunityPlansPlanIdDownload from "@/server/routes/api/community/plans/[planId]/download/route";
import * as apiCommunityPlansPlanIdPreview from "@/server/routes/api/community/plans/[planId]/preview/route";
import * as apiCommunityPlansPlanIdView from "@/server/routes/api/community/plans/[planId]/view/route";
import * as apiCommunityPlansPlanIdVote from "@/server/routes/api/community/plans/[planId]/vote/route";
import * as apiDatasetsVersionIdCatalog from "@/server/routes/api/datasets/[versionId]/catalog/route";
import * as apiDatasetsVersionIdClientFiles from "@/server/routes/api/datasets/[versionId]/client-files/route";
import * as apiDatasetsVersionIdCrops from "@/server/routes/api/datasets/[versionId]/crops/route";
import * as apiDatasetsVersionIdMobs from "@/server/routes/api/datasets/[versionId]/mobs/route";
import * as apiDatasetsVersionIdPrewarm from "@/server/routes/api/datasets/[versionId]/prewarm/route";
import * as apiDatasetsVersionIdRecipeIds from "@/server/routes/api/datasets/[versionId]/recipe-ids/route";
import * as apiDatasetsVersionIdRecipes from "@/server/routes/api/datasets/[versionId]/recipes/route";
import * as apiDatasetsVersionIdRecipesRecipeId from "@/server/routes/api/datasets/[versionId]/recipes/[recipeId]/route";
import * as apiDatasetsVersionIdResolveRecipes from "@/server/routes/api/datasets/[versionId]/resolve-recipes/route";
import * as apiDatasetsVersionIdResources from "@/server/routes/api/datasets/[versionId]/resources/route";
import * as apiHighsFile from "@/server/routes/api/highs/[file]/route";
import * as apiLibrary from "@/server/routes/api/library/route";
import * as apiLibraryDesignsDesignId from "@/server/routes/api/library/designs/[designId]/route";
import * as apiLibraryDesignsDesignIdMembers from "@/server/routes/api/library/designs/[designId]/members/route";
import * as apiLibraryDesignsDesignIdMembersUserId from "@/server/routes/api/library/designs/[designId]/members/[userId]/route";
import * as apiLibraryFoldersFolderId from "@/server/routes/api/library/folders/[folderId]/route";
import * as apiResourcePopularity from "@/server/routes/api/resource-popularity/route";
import * as apiVersion from "@/server/routes/api/version/route";
import * as datasetFilesVersionIdAssetPath from "@/server/routes/dataset-files/[versionId]/[...assetPath]/route";
import * as datasetsGtnhVersionIdTexturesAssetPath from "@/server/routes/datasets/gtnh/[versionId]/textures/[...assetPath]/route";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type RouteContext = { params: Promise<Record<string, string | string[]>> };

export type WebHandler = (request: Request, context: RouteContext) => Response | Promise<Response>;

export type RouteModule = Partial<Record<HttpMethod, WebHandler>>;

/**
 * A route answered as a static file: every method gets the GET answer, and an answer with no Cache-Control of
 * its own gets `s-maxage=31536000`. The wire keeps the answers Next gave the route it served from its prerender
 * cache. Named in the table by hand.
 */
export type RouteServing = "static";

export interface RouteEntry {
  /** The Express 5 path: `:name` for `[name]`, `*name` for `[...name]`. */
  path: string;
  /** The route file's repo path. */
  source: string;
  module: RouteModule;
  serving?: RouteServing;
}

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * The Express 5 path a route file's folders name: `[id]` becomes `:id` and
 * `[...rest]` becomes `*rest`. Other folder names, dotted ones included, are
 * literal segments.
 */
export function routePathForFile(file: string): string {
  const folders = file.replace(/^src\/server\/routes/, "").replace(/\/route\.[jt]sx?$/, "");
  return folders
    .split("/")
    .map((segment) => segment.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1"))
    .join("/");
}

/**
 * The `Allow` value of Next's OPTIONS answer: every exported method, plus
 * HEAD when GET is exported, plus OPTIONS, sorted and joined with ", ".
 * Next sends no `Allow` on a 405.
 */
export function optionsAllow(module: RouteModule): string {
  const allowed = new Set<string>(Object.keys(module));
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return [...allowed].sort().join(", ");
}

/** The folder names of a route file's path, one per union member. */
type Segments<S extends string> = S extends `${infer Head}/${infer Rest}`
  ? Head | Segments<Rest>
  : S;

type CatchAllNames<S extends string> =
  Segments<S> extends infer Segment ? (Segment extends `[...${infer Name}]` ? Name : never) : never;

type ParamNames<S extends string> =
  Segments<S> extends infer Segment
    ? Segment extends `[...${string}]`
      ? never
      : Segment extends `[${infer Name}]`
        ? Name
        : never
    : never;

/**
 * The params a route file's folders give its handlers: `[x]` is `x: string`, `[...x]` is `x: string[]`, as the
 * adapter passes them by folder name.
 */
export type ParamsOf<S extends string> = { [K in ParamNames<S>]: string } & {
  [K in CatchAllNames<S>]: string[];
};

/**
 * What a route file may export as handlers, checked against its folders: a handler that names a param its path
 * does not give (a typo, a renamed folder) is a type error here.
 */
type TypedRouteModule<S extends string> = {
  [M in HttpMethod]?: (
    request: Request,
    context: { params: Promise<ParamsOf<S>> },
  ) => Response | Promise<Response>;
};

/** The method exports of a route module: anything else it exports is not a handler. */
function pick(module: Record<string, unknown>): RouteModule {
  const picked: RouteModule = {};
  for (const method of METHODS) {
    const handler = module[method];
    if (typeof handler === "function") picked[method] = handler as WebHandler;
  }
  return picked;
}

/**
 * One table entry. The module's handlers are checked against `ParamsOf<source>` first; the one cast after that
 * check widens them to the shared context type, which is sound because the adapter passes exactly the params the
 * folders name. The test holds that `module` is the file `source` names.
 */
function entry<S extends string>(
  source: S,
  module: TypedRouteModule<S>,
  serving?: RouteServing,
): RouteEntry {
  return {
    path: routePathForFile(source),
    source,
    module: pick(module as Record<string, unknown>),
    ...(serving ? { serving } : {}),
  };
}

/**
 * In Next's precedence: within a folder, a static segment comes before a
 * dynamic one and a dynamic one before a catch-all, because Express answers
 * with the first path that matches.
 */
export const ROUTES: readonly RouteEntry[] = [
  entry("src/server/routes/api/accounts/search/route.ts", apiAccountsSearch),
  entry("src/server/routes/api/blueprints/route.ts", apiBlueprints),
  entry("src/server/routes/api/blueprints/[blueprintId]/route.ts", apiBlueprintsBlueprintId),
  entry("src/server/routes/api/community/auth/login/route.ts", apiCommunityAuthLogin),
  entry("src/server/routes/api/community/auth/logout/route.ts", apiCommunityAuthLogout),
  entry("src/server/routes/api/community/auth/me/route.ts", apiCommunityAuthMe),
  entry("src/server/routes/api/community/auth/register/route.ts", apiCommunityAuthRegister),
  entry("src/server/routes/api/community/images/route.ts", apiCommunityImages),
  entry(
    "src/server/routes/api/community/images/[month]/[name]/route.ts",
    apiCommunityImagesMonthName,
  ),
  entry("src/server/routes/api/community/plans/route.ts", apiCommunityPlans),
  entry("src/server/routes/api/community/plans/[planId]/route.ts", apiCommunityPlansPlanId),
  entry(
    "src/server/routes/api/community/plans/[planId]/comments/route.ts",
    apiCommunityPlansPlanIdComments,
  ),
  entry(
    "src/server/routes/api/community/plans/[planId]/comments/[commentId]/route.ts",
    apiCommunityPlansPlanIdCommentsCommentId,
  ),
  entry(
    "src/server/routes/api/community/plans/[planId]/download/route.ts",
    apiCommunityPlansPlanIdDownload,
  ),
  entry(
    "src/server/routes/api/community/plans/[planId]/preview/route.ts",
    apiCommunityPlansPlanIdPreview,
  ),
  entry(
    "src/server/routes/api/community/plans/[planId]/view/route.ts",
    apiCommunityPlansPlanIdView,
  ),
  entry(
    "src/server/routes/api/community/plans/[planId]/vote/route.ts",
    apiCommunityPlansPlanIdVote,
  ),
  entry("src/server/routes/api/datasets/[versionId]/catalog/route.ts", apiDatasetsVersionIdCatalog),
  entry(
    "src/server/routes/api/datasets/[versionId]/client-files/route.ts",
    apiDatasetsVersionIdClientFiles,
  ),
  entry("src/server/routes/api/datasets/[versionId]/crops/route.ts", apiDatasetsVersionIdCrops),
  entry("src/server/routes/api/datasets/[versionId]/mobs/route.ts", apiDatasetsVersionIdMobs),
  entry("src/server/routes/api/datasets/[versionId]/prewarm/route.ts", apiDatasetsVersionIdPrewarm),
  entry(
    "src/server/routes/api/datasets/[versionId]/recipe-ids/route.ts",
    apiDatasetsVersionIdRecipeIds,
  ),
  entry("src/server/routes/api/datasets/[versionId]/recipes/route.ts", apiDatasetsVersionIdRecipes),
  entry(
    "src/server/routes/api/datasets/[versionId]/recipes/[recipeId]/route.ts",
    apiDatasetsVersionIdRecipesRecipeId,
  ),
  entry(
    "src/server/routes/api/datasets/[versionId]/resolve-recipes/route.ts",
    apiDatasetsVersionIdResolveRecipes,
  ),
  entry(
    "src/server/routes/api/datasets/[versionId]/resources/route.ts",
    apiDatasetsVersionIdResources,
  ),
  entry("src/server/routes/api/highs/[file]/route.ts", apiHighsFile, "static"),
  entry("src/server/routes/api/library/route.ts", apiLibrary),
  entry("src/server/routes/api/library/designs/[designId]/route.ts", apiLibraryDesignsDesignId),
  entry(
    "src/server/routes/api/library/designs/[designId]/members/route.ts",
    apiLibraryDesignsDesignIdMembers,
  ),
  entry(
    "src/server/routes/api/library/designs/[designId]/members/[userId]/route.ts",
    apiLibraryDesignsDesignIdMembersUserId,
  ),
  entry("src/server/routes/api/library/folders/[folderId]/route.ts", apiLibraryFoldersFolderId),
  entry("src/server/routes/api/resource-popularity/route.ts", apiResourcePopularity),
  entry("src/server/routes/api/version/route.ts", apiVersion),
  entry(
    "src/server/routes/dataset-files/[versionId]/[...assetPath]/route.ts",
    datasetFilesVersionIdAssetPath,
  ),
  entry(
    "src/server/routes/datasets/gtnh/[versionId]/textures/[...assetPath]/route.ts",
    datasetsGtnhVersionIdTexturesAssetPath,
  ),
];
