# Proposal 0008, Game Loop and Campaign

*Drafted 2026-11-18. Status: accepted. Affects `docs/design.md`, `TODO.md`, `CLAUDE.md`, and all earlier proposals' roadmap sections, which this proposal and `docs/roadmap.md` supersede.*

*Proposal 0012 (decision 302) adds the AC-31 gunship and its four missions to the breadth phase (R4.10), the Mi-24 analogue's convoy escort and armed reconnaissance, and a side's standing as ceasefire pressure.*

*Proposal 0013 (decision 331) splits the entity level for infantry into squads in the bubble and individual soldiers within 3–5 km, puts survivors on foot with enemy search parties, makes captured pilots and surrendered soldiers prisoners that count in the campaign, and rules out civilians for good (R3.8).*

## Purpose

The flight model works and the terrain is in good shape. Bearing now moves from a world and a flyable aircraft to a game: a war that plans, fights, and resolves itself, with the player jumping into any part of it. This proposal defines the game loop, the architecture for mission and aircraft types, the campaign, and the decisions that shape the roadmap. The first goal is a tech demo of one day of war; the project then continues to the full dynamic campaign.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Tech demo | One theater, 24 game hours, four mission types (CAP, interdiction, CAS, airlift), three or four flyable aircraft |
| 2 | First roster | See *Roster* |
| 3 | Player identity | Hybrid: ghost by default, plus a named pilot who belongs to a squadron and builds reputation by flying its missions |
| 4 | Ejection | Every ejected pilot, on either side, generates a survivor and a CSAR mission for the owning side; no permadeath in ghost mode |
| 5 | Campaign | Two to four weeks of game time, ending in a breakthrough, a successful defense, or a ceasefire from mutual exhaustion |
| 6 | Naval war | Aggregate convoys, carrier groups, surface groups, and abstract submarines; the player never commands ships |
| 7 | Multiplayer | Later; the simulation keeps a player input event log so that co-op remains possible |
| 8 | Save and load | Campaign state in IndexedDB with file export and import; the event log exists from the demo onward |
| 9 | Ground war in the demo | Battalions as aggregates plus minimal entity promotion near the player, so CAS attacks real vehicles |

## The Game Loop

The war runs in a cycle that never waits for the player:

1. **Plan.** Each side's command layer builds an air tasking order from theater needs, available aircraft, pilots, and supplies, and revises it every few game hours.
2. **Execute.** Missions fly. Most resolve at the aggregate level; missions the player watches or flies run at full fidelity.
3. **Resolve.** Engagements produce losses, damage, delivered supplies, destroyed targets, and ejected pilots.
4. **Consequence.** Results feed the ground war, the naval war, logistics, and morale. Fronts move, depots empty, bridges fall, squadrons lose pilots.
5. **Replan.** The next planning cycle responds to the new situation.

The player enters the loop through mission search: find a mission, follow it, take over at any point in its jump-in window, fly it, and hand it back. A good sortie changes the war through the same consequence step as any other mission, amplified by morale and reputation.

### Clocks

- **Campaign clock:** game time with day and night, driving the air tasking cycle (one order per day, revisions every two to four hours).
- **Ground and naval ticks:** fixed game-time steps for aggregate combat and movement, as in `docs/design.md`.
- **Events:** takeoffs, arrivals, engagements, ejections, and mission phase changes as scheduled events.
- **Acceleration:** pause to 256×, with auto-slowdown on subscribed events and the flight cap while the player flies.

## Mission Types as Plug-ins

Every mission type is a plug-in with a fixed set of parts. A new mission type is complete only when all parts exist.

| Part | Purpose |
|---|---|
| Planner rule | When and why the air tasking order creates this mission, with priority scoring |
| Package template | Flights, roles, escorts, and support the mission needs |
| Aggregate resolver | How the mission plays out when no one watches, producing the same kinds of outcomes as full fidelity |
| Full-fidelity behavior | How AI pilots fly it when watched or after handback |
| Jump-in windows | Which phases accept the player |
| Success criteria and consequences | What counts as success, and what changes in the world |
| Briefing template | Generated briefing text using named places |
| Interface defaults | Master mode, display formats, and HUD cues for each phase |

### Demo Mission Types

CAP, interdiction, CAS (fixed-wing), and airlift.

### Full Catalog

Added in the breadth phase: fighter sweep, escort, scramble from quick-reaction alert, low-level penetration strike, stealth strike, SEAD, attack helicopter CAS, helicopter assault and troop insertion, anti-shipping, maritime patrol, strategic bombing, reconnaissance, AWACS and tanker support, combat airdrop, sling-load resupply, CSAR, and medical evacuation.

## Aircraft Types as Bundles

Every aircraft type is a single bundle in its JSON specification:

- geometry from the procedural model builder, with animated parts;
- flight model data (fixed-wing or rotary);
- avionics profile and display complement (proposal 0006);
- pylon stations and loadouts;
- role tags used by the planner;
- crew roles (proposal 0006);
- camera rig settings;
- aggregate performance values, derived from calibration (see below);
- faction, name, and skin.

## Roster

| Phase | Alliance | Pact |
|---|---|---|
| Demo, flyable | F-21 Kestrel (F-16), A-10 analogue, C-130 analogue | MiG-29 analogue, Su-25 analogue |
| Demo, AI-only | F-15 analogue, Black Hawk analogue, E-3 analogue, KC-135 analogue | Su-24 analogue, An-12 analogue, Mi-24 analogue, Mi-8 analogue, A-50 analogue |
| Breadth | F-15, Black Hawk become flyable; F-111, A-6, F-14, F-117, Apache, Lynx, Cobra, CH-47 analogues | Su-24, Mi-24, Mi-8 become flyable; Su-27, Tu-22M, Tu-95, MiG-23, Mi-26 analogues |

The demo needs at least one flyable aircraft per side; the exact flyable set may shift with the audit's findings.

## Fidelity Consistency and Calibration

Aggregate resolvers and full-fidelity simulation must agree, or the war behaves differently depending on whether the player watches. Bearing calibrates aggregate outcome tables offline: a script runs many headless full-fidelity engagements per matchup (for example, two MiG-29 analogues against two F-21 Kestrels at a given range and altitude) and fits the aggregate tables to the results. Calibration tables live in the repository, a script regenerates them, and tests check that aggregate and full-fidelity outcome rates stay within tolerance.

When the player starts watching an aggregate mission, the simulation instantiates its full-fidelity state from the aggregate state (positions, fuel, weapons, damage). When the player stops watching, it folds the state back. Both directions preserve losses and expended weapons.

## Ground War

The demo's ground war uses aggregate battalions along the front, with attrition, supply, and posture, and **minimal entity promotion**: near the player, a battalion spawns a handful of representative vehicles (tanks, infantry fighting vehicles, trucks, a short-range air defense vehicle) that can be targeted, with losses fed back into the battalion's strength. Full entity behavior follows in the combat depth phase.

## Naval War

Aggregate naval groups (convoys, carrier groups, surface action groups, and abstract submarines) move on sea lanes and fight with aggregate resolvers. Air missions interact with them through anti-shipping strikes, maritime patrol, convoy escort, and carrier operations. The naval war arrives in the breadth phase.

## Player Identity

- **Ghost.** The player can jump into any aircraft on their side. Ghost play has no permanent consequences for the player.
- **Named pilot.** The player also has a named pilot assigned to one squadron. Flying that squadron's missions builds the pilot's reputation, which affects squadron morale, and the enemy may react to a well-known pilot (raids on the home base, fighters hunting the callsign).
- **Loss.** If the named pilot ejects, the CSAR outcome decides their fate: rescued pilots return, captured or killed pilots lose their reputation, and the player creates a new named pilot.

## Ejection and CSAR

Every ejection, on either side, creates a **survivor** on the ground with a position, an injury state, a survival timer, and a capture risk that grows near enemy forces. The owning side's planner always generates a CSAR mission: a rescue helicopter, escorts, and on-scene cover. The player can fly any part of it. Outcomes are rescued, captured, or killed. Rescued pilots return to their squadron's pilot pool, which limits sortie generation, so CSAR matters to the campaign. Enemy survivors also generate enemy CSAR missions, which the player can try to stop.

## Campaign

- **Length:** two to four weeks of game time, roughly 10 to 30 hours of play with acceleration.
- **Logistics:** fuel, munitions, spares, and replacement aircraft and pilots flow over the road, rail, and sea networks to depots, bases, and the front. Base stocks gate sortie generation.
- **Morale and reputation:** unit, squadron, and theater morale change sortie rates, AI skill, and ground combat effectiveness. Player successes raise morale with decay and caps.
- **Consequence visibility:** after a mission, the strategic map shows the chain of consequences (bridge down, supply cut, battalion withdrawing).
- **End conditions:** a breakthrough (an objective line or capital taken), a successful defense (the attacker's offensive capacity exhausted), or a ceasefire when both sides fall below exhaustion thresholds. A campaign summary closes the war.

## Persistence

From the demo onward, the simulation records an **event log** of player inputs and campaign-level decisions. A saved campaign is a state snapshot plus the log since the snapshot. Replaying the log from a snapshot reproduces the same state, which also enables replays, debugging, and later co-op. Saves live in IndexedDB and export and import as files.

## Roadmap Phases

`docs/roadmap.md` details these phases with milestones, tasks, dependencies, and exit criteria:

- **R0. Audit and reconcile.** Status of all earlier proposals and tasks; documents brought in line with the code.
- **R1. Consolidation.** Whatever the loop needs from earlier tracks: simulation worker, time acceleration, strategic graph, casting, settlements and bases, mission search shell.
- **R2. One day of war (tech demo).** The thin, complete loop.
- **R3. Combat depth.** Sensors and radar, weapons, air combat, air defense networks and scrambles, entity behavior for ground units.
- **R4. Breadth.** The roster, the full mission catalog, the helicopter track, transport operations, naval war.
- **R5. Dynamic campaign.** Logistics, morale and reputation, multi-day campaigns, end conditions, save and load, consequence visibility.
- **R6. Polish.** Onboarding, briefings and after-action views, audio, performance, accessibility.

### Tech Demo Exit Criteria

- A full 24 game hours runs unattended at 64× without errors, in at least three seeds with a continental front.
- Both sides generate and revise air tasking orders with all four demo mission types.
- The front moves measurably in response to mission outcomes, and a run with air support suppressed on one side produces a different front than a normal run.
- The player finds a mission through search, follows it, takes over, flies it, and hands it back, in each flyable aircraft.
- CAS strikes promoted vehicles, and the losses appear in the battalion's strength.
- Every ejection produces a survivor and a CSAR mission.
- Replaying a session's event log from its starting snapshot reproduces the same final state.
- Aggregate and full-fidelity outcomes for the demo matchups agree within the calibration tolerance.
- Performance stays within the frame budgets in `docs/visual-style.md` during a full-fidelity mission with the war running.
