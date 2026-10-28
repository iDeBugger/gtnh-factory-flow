import { PIN_RULE_LABEL, PIN_RULE_ORDER, type PinRule } from "@/lib/model/pin-rule";
import { BoardMenu, MenuRow } from "./BoardMenu";
import type { MenuAnchor } from "./MenuPortal";

/** What each rule means, beside its name. */
const RULE_DETAIL: Record<PinRule, string> = {
  any: "the plan picks",
  upTo: "what you have",
  exact: "no matter what",
};

/**
 * The count's rule (docs/up-to.md), opened from the rule word under the machine: Any, Up to, Exactly, the one in use
 * ticked. The board's one menu (`BoardMenu`), under the word.
 */
export function CountRuleMenu({
  anchor,
  rule,
  onPick,
  onClose,
}: {
  anchor: MenuAnchor;
  rule: PinRule;
  onPick: (rule: PinRule) => void;
  onClose: () => void;
}) {
  return (
    <BoardMenu
      x={anchor.left}
      y={anchor.bottom + 2}
      label="Machine count"
      title="Machine count"
      onClose={onClose}
    >
      {PIN_RULE_ORDER.map((entry) => (
        <MenuRow
          key={entry}
          label={PIN_RULE_LABEL[entry]}
          detail={RULE_DETAIL[entry]}
          checked={entry === rule}
          onClick={() => {
            onClose();
            if (entry !== rule) onPick(entry);
          }}
        />
      ))}
    </BoardMenu>
  );
}
