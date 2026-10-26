/** Said to the player once, on the board's notice bar, about what a landing or an edit changed in the plan. */
export interface PlanNotice {
  text: string;
  /** Short lines under the text. */
  details: string[];
}
