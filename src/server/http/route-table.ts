/**
 * Every route handler and the Express 5 path it answers on. The table is
 * explicit, with static imports, so nothing is discovered at run time; the
 * test derives each path from its file, so the table cannot drift from the
 * folders.
 */
import * as apiAccountsSearch from "@/app/api/accounts/search/route";
import * as apiBlueprints from "@/app/api/blueprints/route";
import * as apiBlueprintsBlueprintId from "@/app/api/blueprints/[blueprintId]/route";
import * as apiCommunityAuthLogin from "@/app/api/community/auth/login/route";
import * as apiCommunityAuthLogout from "@/app/api/community/auth/logout/route";
import * as apiCommunityAuthMe from "@/app/api/community/auth/me/route";
import * as apiCommunityAuthRegister from "@/app/api/community/auth/register/route";
import * as apiCommunityImages from "@/app/api/community/images/route";
import * as apiCommunityImagesMonthName from "@/app/api/community/images/[month]/[name]/route";
import * as apiCommunityPlans from "@/app/api/community/plans/route";
import * as apiCommunityPlansPlanId from "@/app/api/community/plans/[planId]/route";
import * as apiCommunityPlansPlanIdComments from "@/app/api/community/plans/[planId]/comments/route";
import * as apiCommunityPlansPlanIdCommentsCommentId from "@/app/api/community/plans/[planId]/comments/[commentId]/route";
import * as apiCommunityPlansPlanIdDownload from "@/app/api/community/plans/[planId]/download/route";
import * as apiCommunityPlansPlanIdPreview from "@/app/api/community/plans/[planId]/preview/route";
import * as apiCommunityPlansPlanIdView from "@/app/api/community/plans/[planId]/view/route";
import * as apiCommunityPlansPlanIdVote from "@/app/api/community/plans/[planId]/vote/route";
import * as apiDatasetsVersionIdCatalog from "@/app/api/datasets/[versionId]/catalog/route";
import * as apiDatasetsVersionIdClientFiles from "@/app/api/datasets/[versionId]/client-files/route";
import * as apiDatasetsVersionIdCrops from "@/app/api/datasets/[versionId]/crops/route";
import * as apiDatasetsVersionIdMobs from "@/app/api/datasets/[versionId]/mobs/route";
import * as apiDatasetsVersionIdPrewarm from "@/app/api/datasets/[versionId]/prewarm/route";
import * as apiDatasetsVersionIdRecipeIds from "@/app/api/datasets/[versionId]/recipe-ids/route";
import * as apiDatasetsVersionIdRecipes from "@/app/api/datasets/[versionId]/recipes/route";
import * as apiDatasetsVersionIdRecipesRecipeId from "@/app/api/datasets/[versionId]/recipes/[recipeId]/route";
import * as apiDatasetsVersionIdResolveRecipes from "@/app/api/datasets/[versionId]/resolve-recipes/route";
import * as apiDatasetsVersionIdResources from "@/app/api/datasets/[versionId]/resources/route";
import * as apiHighsFile from "@/app/api/highs/[file]/route";
import * as apiLibrary from "@/app/api/library/route";
import * as apiLibraryDesignsDesignId from "@/app/api/library/designs/[designId]/route";
import * as apiLibraryDesignsDesignIdMembers from "@/app/api/library/designs/[designId]/members/route";
import * as apiLibraryDesignsDesignIdMembersUserId from "@/app/api/library/designs/[designId]/members/[userId]/route";
import * as apiLibraryFoldersFolderId from "@/app/api/library/folders/[folderId]/route";
import * as apiResourcePopularity from "@/app/api/resource-popularity/route";
import * as apiVersion from "@/app/api/version/route";
import * as datasetFilesVersionIdAssetPath from "@/app/dataset-files/[versionId]/[...assetPath]/route";
import * as datasetsGtnhVersionIdTexturesAssetPath from "@/app/datasets/gtnh/[versionId]/textures/[...assetPath]/route";
import * as llmsTxt from "@/app/llms.txt/route";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type RouteContext = { params: Promise<Record<string, string | string[]>> };

export type WebHandler = (request: Request, context: RouteContext) => Response | Promise<Response>;

export type RouteModule = Partial<Record<HttpMethod, WebHandler>>;

export interface RouteEntry {
  /** The Express 5 path: `:name` for `[name]`, `*name` for `[...name]`. */
  path: string;
  /** The route file's repo path. */
  source: string;
  module: RouteModule;
}

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * The Express 5 path a route file's folders name: `[id]` becomes `:id` and
 * `[...rest]` becomes `*rest`. Other folder names, `llms.txt` included, are
 * literal segments.
 */
export function routePathForFile(file: string): string {
  const folders = file.replace(/^src\/app/, "").replace(/\/route\.[jt]sx?$/, "");
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

/**
 * The method exports of a route module. Next's segment config (`runtime`,
 * `dynamic`, `revalidate`, `generateStaticParams`) is not a handler.
 */
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
function entry<S extends string>(source: S, module: TypedRouteModule<S>): RouteEntry {
  return {
    path: routePathForFile(source),
    source,
    module: pick(module as Record<string, unknown>),
  };
}

/**
 * In Next's precedence: within a folder, a static segment comes before a
 * dynamic one and a dynamic one before a catch-all, because Express answers
 * with the first path that matches.
 */
export const ROUTES: readonly RouteEntry[] = [
  entry("src/app/api/accounts/search/route.ts", apiAccountsSearch),
  entry("src/app/api/blueprints/route.ts", apiBlueprints),
  entry("src/app/api/blueprints/[blueprintId]/route.ts", apiBlueprintsBlueprintId),
  entry("src/app/api/community/auth/login/route.ts", apiCommunityAuthLogin),
  entry("src/app/api/community/auth/logout/route.ts", apiCommunityAuthLogout),
  entry("src/app/api/community/auth/me/route.ts", apiCommunityAuthMe),
  entry("src/app/api/community/auth/register/route.ts", apiCommunityAuthRegister),
  entry("src/app/api/community/images/route.ts", apiCommunityImages),
  entry("src/app/api/community/images/[month]/[name]/route.ts", apiCommunityImagesMonthName),
  entry("src/app/api/community/plans/route.ts", apiCommunityPlans),
  entry("src/app/api/community/plans/[planId]/route.ts", apiCommunityPlansPlanId),
  entry("src/app/api/community/plans/[planId]/comments/route.ts", apiCommunityPlansPlanIdComments),
  entry(
    "src/app/api/community/plans/[planId]/comments/[commentId]/route.ts",
    apiCommunityPlansPlanIdCommentsCommentId,
  ),
  entry("src/app/api/community/plans/[planId]/download/route.ts", apiCommunityPlansPlanIdDownload),
  entry("src/app/api/community/plans/[planId]/preview/route.ts", apiCommunityPlansPlanIdPreview),
  entry("src/app/api/community/plans/[planId]/view/route.ts", apiCommunityPlansPlanIdView),
  entry("src/app/api/community/plans/[planId]/vote/route.ts", apiCommunityPlansPlanIdVote),
  entry("src/app/api/datasets/[versionId]/catalog/route.ts", apiDatasetsVersionIdCatalog),
  entry("src/app/api/datasets/[versionId]/client-files/route.ts", apiDatasetsVersionIdClientFiles),
  entry("src/app/api/datasets/[versionId]/crops/route.ts", apiDatasetsVersionIdCrops),
  entry("src/app/api/datasets/[versionId]/mobs/route.ts", apiDatasetsVersionIdMobs),
  entry("src/app/api/datasets/[versionId]/prewarm/route.ts", apiDatasetsVersionIdPrewarm),
  entry("src/app/api/datasets/[versionId]/recipe-ids/route.ts", apiDatasetsVersionIdRecipeIds),
  entry("src/app/api/datasets/[versionId]/recipes/route.ts", apiDatasetsVersionIdRecipes),
  entry(
    "src/app/api/datasets/[versionId]/recipes/[recipeId]/route.ts",
    apiDatasetsVersionIdRecipesRecipeId,
  ),
  entry(
    "src/app/api/datasets/[versionId]/resolve-recipes/route.ts",
    apiDatasetsVersionIdResolveRecipes,
  ),
  entry("src/app/api/datasets/[versionId]/resources/route.ts", apiDatasetsVersionIdResources),
  entry("src/app/api/highs/[file]/route.ts", apiHighsFile),
  entry("src/app/api/library/route.ts", apiLibrary),
  entry("src/app/api/library/designs/[designId]/route.ts", apiLibraryDesignsDesignId),
  entry(
    "src/app/api/library/designs/[designId]/members/route.ts",
    apiLibraryDesignsDesignIdMembers,
  ),
  entry(
    "src/app/api/library/designs/[designId]/members/[userId]/route.ts",
    apiLibraryDesignsDesignIdMembersUserId,
  ),
  entry("src/app/api/library/folders/[folderId]/route.ts", apiLibraryFoldersFolderId),
  entry("src/app/api/resource-popularity/route.ts", apiResourcePopularity),
  entry("src/app/api/version/route.ts", apiVersion),
  entry(
    "src/app/dataset-files/[versionId]/[...assetPath]/route.ts",
    datasetFilesVersionIdAssetPath,
  ),
  entry(
    "src/app/datasets/gtnh/[versionId]/textures/[...assetPath]/route.ts",
    datasetsGtnhVersionIdTexturesAssetPath,
  ),
  entry("src/app/llms.txt/route.ts", llmsTxt),
];
