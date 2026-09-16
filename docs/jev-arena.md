# Jev combat bot

Local, disposable development tool: [Jev arena](http://127.0.0.1:5173/tools/jev.html), also under Tools → Skills & combat. No playable characters, accounts, repositories or saves are loaded. The bot is not enabled in the main game, production, Sites or Android.

## Run locally

1. Use Node 22.13+ (or a supported newer version) and start `npm run dev` from the project root.
2. Put your Typesafe key in the ignored `game/.env.local` as `TYPESAFE_API_KEY`. `game/.env.example` is a blank template. Never use a `VITE_` prefix. Shell environment values take precedence.
3. Open the arena. **Check connection** reads local configuration only; it does not spend an inference request. File changes need no server restart.
4. Choose an encounter and loadout, then **Start**. **Pause**, hiding the tab, reset and leaving the tool cancel pending work and clear the bot’s input. Changing selectors resets disposable state.

The API is Typesafe’s [Choice endpoint](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, `jev-latest`. The development-only `/__jev-arena` proxy requires the exact loopback host, same-origin POST and custom header. Credentials stay server-side. Provider bodies/exceptions are not reflected to the browser. No SDK or production dependency was added.

**Offline control demo · no AI** uses a small disclosed policy over the same actions. It is useful for checking the motor layer; its results are not Jev results.

## Real-time control

Combat always advances while Jev thinks. There is one request in flight, with 200 ms spacing after each response. There is **no request budget**. Runs stop at victory, defeat, five simulation minutes, an error or manual pause. Pause-to-think and its obsolete controls have been removed.

Jev chooses the target and tactical intent. A local motor uses ordinary simulation input to execute that intent:

- **Engage:** route to the selected target in both axes, aim, close safely inside melee reach (continuing pursuit during windup when needed) and repeat basic attacks at the normal equipment cadence. Ranged weapons keep distance when a target is too close.
- **Kite / circle left or right:** pick collision-checked movement relative to the target, preserving line of sight where possible, and fire while in range.
- **Investigate / search:** route to a last-seen position or an unvisited arena sector. A newly visible target ends the search so Jev can choose combat tactics.
- **Evade / dodge:** move along a predicted low-risk escape or spend a normal dodge charge in Jev’s selected direction.
- **Attack / skill / potion / hold:** single normal input presses or an intentional stationary wait. Skill menus use actual assignments, unlocks, equipment compatibility, mana, recovery and cooldowns.

Combat intents continue for at most two simulation seconds without renewal. Fresh responses can replace or renew them while they are executing. Single-action windows last 0.6 seconds. Replies older than two simulation seconds or no longer legal are rejected and reconsidered; they do not replace valid ongoing control. Requests time out after 12 seconds and errors pause without automatic retries. Aborted work may already have been processed by Typesafe. Hidden tabs pause instead of accumulating catch-up time.

During engage/kite/circle, the motor forecasts imminent visible attacks each simulation step. It can dodge if charges and cancellation rules allow it, or sidestep if walking has a lower predicted risk. Dodge invulnerability uses the existing short window, not the whole dodge. Repeated decisions preserve an active evasion instead of cancelling it. The motor does not pick another enemy, select a skill or drink a potion on Jev’s behalf.

All movement, collision, recovery, damage, projectile flight, resource costs, passive blocks and proximity pickups stay with the normal simulation. No teleports, free dodges, hidden-target shooting or extra damage are added. Released player shots do not home.

## Perception and tactics

Observations include the equipped weapon, melee/ranged style, basic damage/range/mana, desired ranged spacing and current resources. A visible enemy has relative x/y, compass bearing, role, velocity, reach, attack warning, body-aware attack eligibility and a body-safe next waypoint/route distance. A priority hint favors reachable kills, dangerous ranged enemies and the current focus; Jev still selects the target.

Only living enemies in the combat viewport with line of sight are refreshed. Lost targets retain their **last observed** position and health for five simulation seconds, marked invisible; they cannot be attacked. Their hidden movement is never read into the observation or pursuit. Search uses authored arena sectors, not hidden enemy locations. Completing the sector circuit permits another search circuit.

Visible projectiles and attack telegraphs produce bounded time-to-impact/risk estimates. The motor uses shared attack definitions, sectors and body collision. Escape options check the path, not only the destination. Risk is a geometric estimate using nominal damage; it is not a guarantee of safety or a copy of the full future simulation. Telegraph aim can still change before it locks.

Ranged aiming uses bounded velocity lead (18 units maximum), only along a visible aim line. Routing reuses `WorldNavigation` and `hasWalkableSegment`. Jev receives the latest six intent outcomes: displacement, damage dealt/taken and change in target distance. Repeated motion commands with no displacement or damage expose a stuck flag so it can change tactics.

The decision desk shows target facts, probabilities, current motor action, waypoint, reflex count and cumulative usage/latency. Exports retain the latest 240 decisions and 150 combat events; cumulative token/response totals survive history truncation. Tokens count received responses only. No key or playable save is exported.

## Fixtures

Each character is level 10 with common equipment, 18 added Vitality and 27 points in the loadout’s offensive attribute. Five rank-one skills are granted; these fixtures are combat studies, not legal atlas allocation examples.

| Loadout | Granted skills |
| --- | --- |
| Longsword + Iron Buckler | Cleave, Shield Bash, Bulwark, Lunge, Brace |
| Thorn Shortbow | Volley, Piercing Shot, Vaulting Shot, Smoke Veil, Brace |
| Cinder Wand + Iron Buckler | Fireball, Frost Lance, Ice Nova, Runic Ward, Brace |

Encounters: one goblin; mixed goblin/stalker/archer; an archer directly north; and an archer beyond a wall. All use normal level-10 enemies and the runtime dungeon renderer/collision. The wall is part of the room’s actual floor outline, not a visual-only prop. Automatic spawning is disabled. This remains a finite arena combat bot; inventory management, build allocation and open-world journeys are not connected.

## Verification and evidence

The current focused suite has 28 code tests covering actual hits, all-axis approach and attack, ranged hits/costs/spacing, a body-sized wall detour, last-seen privacy/expiry, swept projectile risk, normal-charge evasive dodges, attack arcs, dead-target stopping, live decision renewal, expiration, cancellation, bounded history with unlimited requests, and the local HTTP contract with a mocked provider. HTTP tests need temporary loopback listeners. `npm run check` does not drive browser gameplay or call Typesafe.

Before the pursuit follow-up, all 1,618 code tests passed with `--test-concurrency=4`; application/core type checks and the production build passed. The default-concurrency run initially timed out in four cloud-worker subtests (and their parent); those passed both in isolation and in the complete lower-concurrency run. That bot-specific checkpoint passed all 25 checks. Production output retains only the game HTML and contains no Jev modules or endpoint markers.

Nine frozen live-API comparisons after this upgrade selected:

| Fixture | Jev choice |
| --- | --- |
| Sword versus archer north, south, west, east | Engage the archer in all four |
| Bow versus archer north | Engage at ranged distance |
| Wand versus archer north | Basic attack |
| No visible target beyond the wall | Search the nearest unvisited sector |
| Sword enemy already in reach | Basic attack |
| Life at 20% with a potion | Potion |

Responses took 182–679 ms in this sample. These are one response per frozen fixture, not a combat win-rate benchmark. Initial probes exposed idle-search and low-health potion priorities; the final prompt clarifies those priorities. No browser combat was driven. Sustained play and tactical quality remain user-tested. The local endpoint responds, but the Codex in-app preview could not reconnect during this pass, so the revised toolbar/readouts have not been visually verified.

Historical melee correction: the earlier observation omitted enemy body radius, making a center distance of 60 appear beyond a sword range of 54 even though the body was hittable. Four frozen before/after comparisons improved from two to four basic-attack choices. Body-aware reach remains shared between the current observation and menu. Earlier checkpoints passed 1,605 and then 1,607 code tests; those counts describe the preceding implementation.

## Pursuit follow-up

The melee controller previously stopped at the maximum contact boundary, letting a retreating archer escape during windup. Engage now keeps closing toward a position safely inside reach while issuing normal attacks. Routes terminate at a body-safe attack position around the enemy, rather than requiring access to its wall-hugging center. Investigation uses the same reachable approach, without reading hidden movement. Corner steering no longer stops two units short of a waypoint, which could prevent the body from obtaining enough clearance to turn.

A controlled archer retreating at its normal 96 units/second previously took no damage during the first swing; the corrected eastward fixture first connected at 0.183 simulation seconds. Regression coverage includes all four cardinal retreat directions, three actual wall-adjacent enemy positions with sustained hits, and a route around a wall into attack reach. All 28 bot tests plus five shared navigation tests passed (33 total), as did application/core type checks and the production build. This correction affects the shared controller used by both Jev and the offline demo; the division of tactical decisions between them is unchanged. No browser gameplay was driven.

## Ownership

- `game/src/tools/jev-arena-model.ts`: fixture, visible/remembered targets, action menu, intent execution, ordinary simulation input.
- `game/src/tools/jev-tactics.ts`: weapon profile, shared-world routing, visible threat forecasts and body-safe movement candidates.
- `game/src/tools/jev-protocol.ts`: bounded wire reconstruction, fixed tactical prompt and response validation.
- `game/src/tools/jev-pilot.ts`: real-time concurrent decision/motor scheduling, cancellation, stale replies, usage totals and bounded report history.
- `game/src/tools/jev-arena.ts`: local controls, decision desk and production-renderer presentation.
- `game/scripts/jev-proxy.ts`: local-only Vite middleware; excluded from shipped entrypoints.

No save reset.
