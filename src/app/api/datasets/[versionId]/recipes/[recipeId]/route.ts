import { NextResponse } from "next/server";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { getDatasetRecipe } from "@/lib/server/dataset-query";
import { datasetBudgetRefusal } from "@/lib/server/dataset-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string; recipeId: string }> },
) {
  try {
    const { versionId, recipeId } = await params;
    const refusal = datasetBudgetRefusal(request, 1);
    if (refusal) {
      return refusal;
    }
    const recipe = await getDatasetRecipe(versionId, recipeId);
    if (!recipe) {
      return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    }

    return NextResponse.json(recipe, {
      headers: datasetCacheHeaders(request),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recipe load failed." },
      { status: 500 },
    );
  }
}

