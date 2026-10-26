# Buffer drawers

Written 2026-10-14. A buffer is a drawer in the middle of a resource network: cards making the resource feed it, cards
using it draw from it, and it shows what passes through. In the solver it can carry the same rule as any drawer (Any,
At least, Exactly, At most a rate), which then holds the flow through it; the website gives a buffer no rule (it is
always Any, see "On the board"), the mod still offers one. The same feature in both planners: the mod
(`Drawer.Kind.BUFFER`) and the website's one-mode board (a storage both fed and drawn from, `getStorageRoles` =
`"buffer"`). The solver change is identical in the Java balancer and its TypeScript port and is checked by one corpus
case both suites pass (`buffer-drawers`).

## What it is

| | Source | Product / trash | Buffer |
| --- | --- | --- | --- |
| Linked ports | inputs | outputs | outputs (makers) **and** inputs (users) |
| Where its flow goes | into the plan | out of the plan | from its makers to its users, never out |
| Its figure | what it supplies | what it takes | what passes through |
| Rule | on what it supplies | on what it takes | on what passes through |
| Overview rail | an input line | an output line | nothing of its own (the flow is internal) |

A buffer never takes material out of the plan or brings any in. A plan that makes more than its users take still has a
leftover, and it goes where it would go with plain wires: to the network's surplus gate, at a maker's port, shown there
as a Forced row (and offered in the spare popup). A plan short of it imports at a user's port the same way. So a buffer
with rule Any answers exactly as plain wires from each maker to each user would: the importers' conversion of a Factory
Flow buffer (every wire in joined to every wire out) and the buffer drawer are the same plan to the solver.

## In the solver (`balancer/`, `src/lib/solver/plan/`)

The input carries a buffer as a drawer (`SolveInput.DrawerIn` / `DrawerIn`): kind `BUFFER`, its rule and rate, `links`
the output ports that feed it and the new `takers`, the input ports it feeds (empty for every other kind; absent in the
JSON when empty, so every older dump reads the same).

`ModelData` turns it into wiring before anything else looks at the drawers (`buildBuffers`, after the drawn edges):

- one edge from every maker to every user of the same ingredient (`PortIn.resource`), appended after the drawn edges in
  drawer order, then link order, then taker order. Its id is derived from the buffer and the two ports (Java
  `UUID.nameUUIDFromBytes("buffer:<drawer>:<node>#<port>><node>#<port>")`, TS the same string), so the island merge,
  which matches edges by id, finds it;
- those ports become connected ports like any wired port: they join one network (one import gate and one surplus gate,
  `buildGates`), count in `portSteps` as wired ports do, and pass the conservation check;
- the drawer's row (`DrawerRow`) gets the new term family `flowEdges`: the edges it made. Its total is the sum of their
  flows (`SolveContext.drawerTotal`, now given the flows), so the rule's row is `Σ flow_e  >= / = / <= rate`, scaled by
  `1/max(1, rate)` as every drawer row is. `extentMachines` and `externalPorts` stay empty: a buffer's ports' externals
  are the network's gates, not the buffer's.

Everything downstream is unchanged and simply sees more wires:

- AUTO's levels (`TradeStage`) trade at the network's gates as for wires. A buffer rule that asks for flow
  (At least or Exactly a positive rate) is an anchor (`SolveContext.anchored`), as a product's is.
- A rule that cannot be kept goes through the drawer relaxation like any drawer's (`DRAWER_UNMET`, shortfall, limits).
  A buffer with no makers or no users has no edges and no terms: a rule asking for flow is reported
  (`DRAWER_NOT_CONNECTED`) and left out, as for a drawer linked to nothing.
- Islands (`Islands.of`) join a buffer's makers and users.
- Least flow counts the buffer's edges as internal flow, as wires.
- The answer: `edgeFlowsPerSecond` lists drawn edges only (the buffer's are the solver's own). `DrawerReadout.rates`
  has the buffer's throughput, and the new `DrawerReadout.ports` has, per buffer, each linked port with what it puts in
  or takes out (`External(port, rate)`, makers first, then users), which the website needs for each wire's label.
  Every golden gains `"ports": {}` in its drawer read-out; no number moved.

## Saves and plans

- Mod: `Drawer` gains `takers` (a list of links, Gson field, empty for every other kind) and the kind `BUFFER`. An older
  build reading a buffer finds an unknown kind, reads it as a product (`sanitize`) and drops the takers.
- Website: nothing new in the schema. A buffer is a `FactoryStorage` with wires in and out (as it always was); its rule
  is the storage's `targetMode` and `targetPerSecond` (positive). A plan's old `bufferMode` and ratio shares are not
  part of the schema and are dropped on parse.
- Between them (`importer/FfConverter`, `library/PlanExport`; website plan JSON): a buffer storage imports as a buffer
  drawer, its feeder wires as links and its taker wires as takers, its rule from `targetMode`/`targetPerSecond`; a buffer
  drawer posts as a storage with a wire from each maker's port and a wire to each user's port. Wires between two
  drawers are still dropped.

## On the board

The same in both:

- **Making one.** Drop a card's input port on a product drawer of its resource (or an output port on a source drawer):
  the drawer becomes a buffer, wired on both sides. Dropping more ports on it adds makers or users; dropping a linked
  port again takes it off. A buffer left with no users is a product again, with no makers a source again; the rule stays.
  On the website the same is wiring a card's input from the product drawer's handle (the role is read off the wires).
- **Look.** The drawer body as the others in the buffer's own colour, teal (`0xFF2E9C8F`, website `--cd-buffer`), with
  a wire socket on both sides (makers dock on its left, users on its right), its figure the throughput with no sign.
  Its body tip: "Buffer: its makers put in what its users take out." The mod adds the rule key and rate box of a
  product (its rule tip: "The plan passes at least / exactly / no more than the rate through it.").
- **Website: no rule.** A buffer only passes what its users take, so the website draws no rule key, rate box or rule
  menu on it, and its adapter sends every buffer as rule Any (`drawerKindAndRule`): a rule stored on it (an older plan,
  the mod's, or one it had as a product) waits until it is a product again. Its row centres in the body instead.
- **Forced rows.** A port linked to a buffer is a wired port: the plan's leftover there shows as its Forced row, as on a
  plain wire (a buffer is not an end of the plan, so it never takes it).
- **Overview.** A buffer adds no input or output line; its resource is internal.
- **Sounds.** As any drawer: linking clacks, bubbles or sparks by what it carries.
- **Menu.** In the mod, the rule menu (Any, At least, Exactly, At most) and Delete; on the website, Delete alone. No
  product/trash cycle in either.
