import { useFactoryStore } from "@/store/factory-store";
import { BoardMenu, MenuLine, MenuRow } from "./BoardMenu";
import { useCardRecipeRows } from "./card-recipe-rows";
import type { MenuAnchor } from "./MenuPortal";

/**
 * A card's rows, in the mod's order (RecipeCard.openActions): "Clone node", "Add another recipe" (the search pinned
 * to this machine; the pick joins the card), "Replace the recipe" (the classic card's key), "Add to a task" (with
 * live plans) and, in red, "Delete node". The recipe rows follow `cardRecipeRows`. The same rows open from the card's
 * actions key and from a right click on the card (BoardContextMenu). The mod's world rows (Show in the world, Remove
 * from the world) have no website equivalent, and its Machine settings row is the card's gear key here.
 */
export function CardRows({
  nodeId,
  onClone,
  onDelete,
  onAddToTask,
  close,
}: {
  nodeId: string;
  onClone: () => void;
  onDelete: () => void;
  /** Task boards come with live plans: without them there is no row. */
  onAddToTask?: () => void;
  close: () => void;
}) {
  const recipeRows = useCardRecipeRows(nodeId);
  const run = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <>
      <MenuRow label="Clone node" onClick={run(onClone)} />
      {recipeRows.addRecipe ? (
        <MenuRow
          label="Add another recipe"
          onClick={run(() => useFactoryStore.getState().browseMachineRecipes(nodeId))}
        />
      ) : null}
      {recipeRows.replace ? (
        <MenuRow
          label="Replace the recipe"
          onClick={run(() => useFactoryStore.getState().beginRecipeRefactor(nodeId))}
        />
      ) : null}
      {onAddToTask ? <MenuRow label="Add to a task" onClick={run(onAddToTask)} /> : null}
      <MenuLine />
      <MenuRow label="Delete node" danger onClick={run(onDelete)} />
    </>
  );
}

/** The card's actions key menu: the card's rows under the key. */
export function CardActionsMenu({
  anchor,
  nodeId,
  onClose,
  onClone,
  onDelete,
  onAddToTask,
}: {
  anchor: MenuAnchor;
  nodeId: string;
  onClose: () => void;
  onClone: () => void;
  onDelete: () => void;
  onAddToTask?: () => void;
}) {
  return (
    <BoardMenu x={anchor.left} y={anchor.bottom + 2} label="Card actions" onClose={onClose}>
      <CardRows
        nodeId={nodeId}
        onClone={onClone}
        onDelete={onDelete}
        onAddToTask={onAddToTask}
        close={onClose}
      />
    </BoardMenu>
  );
}
