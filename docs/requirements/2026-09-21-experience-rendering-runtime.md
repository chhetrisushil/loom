# AI-Native Experience Runtime and Rendering Runtime — technical requirements

- Provenance: **brainstorm output**, recorded verbatim below from `# 1. Executive Summary` onward.
  Drafted 2026-09-21 by the maintainer together with another agent, as a technical requirements
  document for a UI framework in which loom's "UI as projections" model would be split into an
  **Experience Runtime** and a **Rendering Runtime**. The question it was submitted with: should
  this be built as an integral part of loom, or as a separate framework?
- Evaluated in: [the placement evaluation](2026-09-21-experience-rendering-runtime-evaluation.md).
- Target workload: the GenUI product surface — the same one behind
  [the product portfolio evaluation](2026-09-01-product-portfolio-evaluation.md) Part II, the
  [composed-surfaces recipe](../composed-surfaces.md), and the `genUI` / `aetherOS` sibling repos.

The text below is the document as received. Corrections to it are in the evaluation, not here.

---

## Technical Architecture & Implementation Requirements

**Status:** Proposed
**Audience:** Frontend Infrastructure, GenUI/AetherOS, Loom, SDK, and Platform Engineering teams
**Primary objective:** Define the architecture, contracts, runtime semantics, and implementation requirements for an AI-native frontend runtime in which user experiences are dynamically composed, incrementally evolved, and rendered across multiple surfaces.

---

# 1. Executive Summary

Modern frontend frameworks such as React and Angular are fundamentally optimized around a developer-authored UI tree.

The emerging AI-native application model is different.

In an AI-native application:

```text
User Intent
    ↓
Agent / Application Logic
    ↓
Experience
    ↓
Rendering
    ↓
Platform
```

The UI is no longer necessarily a fixed artifact authored ahead of time. It may be:

* generated dynamically,
* incrementally composed,
* modified as new information becomes available,
* personalized using runtime context,
* adapted to the target surface,
* streamed progressively,
* mutated by agents,
* driven by capabilities and data rather than predefined routes,
* shared across web, mobile, chat, embedded, and other surfaces.

This document defines two new runtime layers:

### Experience Runtime

Responsible for determining and maintaining **what experience should exist**.

### Rendering Runtime

Responsible for determining **how that experience is materialized on a particular platform**.

The canonical representation MUST NOT be a React component tree, DOM tree, Flutter widget tree, or other platform-specific rendering structure.

Instead:

```text
Experience Model
       ↓
Experience IR
       ↓
Rendering IR
       ↓
Platform Renderer
```

React, Angular, Flutter, native UI, Slack, Teams, and other renderers become platform-specific implementations underneath the Rendering Runtime.

---

# 2. Goals

## 2.1 Primary Goals

The system MUST:

1. Represent an application experience independently of a specific rendering technology.
2. Allow experiences to be dynamically created from user intent.
3. Allow experiences to evolve incrementally without full regeneration.
4. Support agent-driven experience mutations.
5. Support streaming and progressive rendering.
6. Support multiple rendering surfaces from the same canonical experience.
7. Support deterministic rendering for a given experience state and platform context.
8. Separate business/application execution from experience composition.
9. Separate experience semantics from rendering implementation.
10. Support React, Angular, Flutter, native, Slack, Teams, and future rendering targets.
11. Support persistent experiences.
12. Support ephemeral experiences.
13. Support real-time experiences.
14. Support long-running experiences.
15. Support partial loading and deferred computation.
16. Support accessibility and device adaptation as first-class rendering concerns.
17. Provide observability for experience creation, mutation, rendering, and interaction.
18. Provide strong security boundaries between intent, capability execution, and rendering.
19. Enable deterministic replay of experience evolution.
20. Allow the runtime to operate without an LLM for already-materialized experiences.

---

# 3. Non-Goals

The Experience Runtime MUST NOT become:

* a general-purpose LLM orchestration framework,
* an MCP server,
* a database,
* a replacement for Loom's execution engine,
* a replacement for React,
* a replacement for Angular,
* a DOM implementation,
* a design system,
* a business-domain-specific application framework.

The Rendering Runtime MUST NOT:

* make business decisions,
* infer user intent,
* independently invoke arbitrary tools,
* directly ask an LLM to determine UI structure,
* bypass authorization,
* become responsible for application workflow execution.

---

# 4. Architectural Principles

## 4.1 Experience Is the Canonical Representation

The canonical application representation MUST be an Experience Model.

It MUST NOT be:

* JSX,
* HTML,
* DOM,
* React Fiber,
* Angular component tree,
* Flutter widget tree.

---

## 4.2 Semantic Before Visual

Experience definitions MUST describe semantic intent before visual implementation.

For example:

```text
Trend
Metric
Collection
Insight
Entity
Action
Navigation
Form
Investigation
Timeline
Status
```

rather than requiring the canonical model to contain:

```text
LineChart
Card
Button
Div
FlexBox
Grid
```

Platform renderers MAY map semantic primitives to concrete visual components.

---

## 4.3 Agent Independence

Agents MUST operate on experience semantics.

An agent SHOULD express:

```text
Add an investigation panel.
```

rather than:

```text
Insert React component X after node Y.
```

The Experience Runtime MUST translate semantic mutations into runtime state changes.

---

## 4.4 Rendering Determinism

The Rendering Runtime MUST be deterministic for a fixed:

```text
Experience State
+
Rendering IR
+
Platform Capabilities
+
Theme
+
Accessibility Configuration
+
Viewport / Device Context
```

The renderer MUST NOT require an LLM to render an existing experience.

---

## 4.5 Incremental Mutation

The runtime MUST support mutation of an existing experience.

A mutation MUST NOT require complete regeneration of the experience.

---

## 4.6 Execution and Rendering Separation

Execution determines:

> What work happens?

Experience Runtime determines:

> What experience should exist?

Rendering Runtime determines:

> How should that experience appear here?

---

# 5. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        Application                           │
│                                                             │
│ User Intent / Business Workflow / Agent                    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     EXPERIENCE RUNTIME                      │
│                                                             │
│  Intent Model                                               │
│  Context Model                                              │
│  Capability Model                                           │
│  Experience State                                           │
│  Experience Graph                                           │
│  Policy Engine                                              │
│  Experience Planner                                         │
│  Mutation Engine                                            │
│  Lifecycle Manager                                          │
│  Persistence                                                │
│  Observation / Telemetry                                    │
└────────────────────────────┬────────────────────────────────┘
                             │
                       Experience IR
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    RENDERING RUNTIME                        │
│                                                             │
│  Rendering Compiler                                         │
│  Layout Engine                                              │
│  Semantic Component Resolver                                │
│  Rendering Scheduler                                        │
│  Streaming Engine                                           │
│  Patch Engine                                               │
│  Device Adaptation                                          │
│  Accessibility Engine                                      │
│  Interaction Runtime                                        │
│  Renderer Lifecycle                                         │
└────────────────────────────┬────────────────────────────────┘
                             │
                       Rendering IR
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         Web Renderer   Mobile Renderer  Conversational
              │              │              │
           React/DOM      Flutter/Native   Slack/Teams
```

---

# 6. Runtime Boundaries

## 6.1 Experience Runtime

The Experience Runtime owns:

* intent,
* experience state,
* experience graph,
* capability references,
* data dependencies,
* semantic components,
* actions,
* experience mutations,
* lifecycle,
* policies,
* persistence,
* experience versioning,
* experience event history.

---

## 6.2 Rendering Runtime

The Rendering Runtime owns:

* rendering compilation,
* layout,
* platform adaptation,
* semantic component resolution,
* rendering scheduling,
* progressive rendering,
* rendering patches,
* hydration,
* local interaction state,
* accessibility,
* viewport adaptation,
* renderer lifecycle.

---

## 6.3 Loom

Loom owns execution concerns such as:

* workflow execution,
* agent execution,
* durable execution,
* scheduling,
* event processing,
* retries,
* replay,
* tool execution,
* long-running workflows.

The Experience Runtime MAY execute work through Loom.

The Experience Runtime MUST NOT duplicate Loom's durable execution semantics.

---

# 7. Experience Model

The Experience Model is the canonical representation of an experience.

Conceptually:

```typescript
interface Experience {
  id: ExperienceId;
  version: number;

  intent: Intent;
  context: ExperienceContext;

  state: ExperienceState;

  entities: EntityRegistry;
  capabilities: CapabilityReference[];

  graph: ExperienceGraph;

  dataDependencies: DataDependency[];

  actions: ActionDefinition[];

  policies: ExperiencePolicy[];

  lifecycle: ExperienceLifecycle;

  metadata: ExperienceMetadata;
}
```

---

# 8. Intent Model

Intent represents the objective of the experience.

```typescript
interface Intent {
  id: string;
  objective: string;

  domain?: string;

  constraints?: Constraint[];

  requestedOutcome?: string;

  confidence?: number;

  source:
    | "user"
    | "agent"
    | "application"
    | "system";
}
```

The runtime MUST preserve the original intent separately from subsequent experience mutations.

Intent MUST be immutable once the experience is created.

A new intent MAY create a new experience or an explicit intent transition.

---

# 9. Context Model

Context represents runtime information used to construct the experience.

```typescript
interface ExperienceContext {
  user?: UserContext;
  session?: SessionContext;

  application?: ApplicationContext;

  environment?: EnvironmentContext;

  device?: DeviceContext;

  locale?: LocaleContext;

  permissions?: PermissionContext;

  temporal?: TemporalContext;

  entities?: EntityContext[];
}
```

Context MUST be versioned.

Context changes MUST be observable.

Sensitive context MUST NOT automatically become part of persisted experience state.

---

# 10. Experience State

Experience state represents the current semantic state of the experience.

```typescript
interface ExperienceState {
  values: Record<string, unknown>;

  selections: Record<string, unknown>;

  filters: Record<string, unknown>;

  observations: Observation[];

  hypotheses: Hypothesis[];

  activeActions: ActionExecution[];

  userInteractionState: InteractionState;
}
```

Experience state MUST be independent of platform-specific UI state.

For example:

```text
Selected database = orders-db
```

is experience state.

Whereas:

```text
React component is currently focused
```

is rendering/runtime state.

---

# 11. Experience Graph

The Experience Graph represents semantic relationships.

```typescript
interface ExperienceGraph {
  nodes: ExperienceNode[];
  edges: ExperienceEdge[];
}
```

Example:

```text
Checkout
   │
   ├── measuredBy → ConversionRate
   │
   ├── affectedBy → PaymentFailures
   │
   ├── investigatedBy → PaymentInvestigation
   │
   └── action → InspectProvider
```

Nodes MUST have stable identifiers.

Nodes MUST support incremental insertion, replacement, removal, and updates.

---

# 12. Semantic Node Model

A node MUST have semantic identity.

```typescript
interface ExperienceNode {
  id: string;

  type: SemanticNodeType;

  role?: string;

  label?: LocalizedText;

  data?: DataBinding;

  children?: string[];

  actions?: string[];

  visibility?: VisibilityRule;

  lifecycle?: NodeLifecycle;

  metadata?: Record<string, unknown>;
}
```

Initial semantic node types SHOULD include:

```text
Container
Metric
Trend
Collection
Entity
Insight
Status
Action
Form
Filter
Navigation
Timeline
Visualization
Investigation
Explanation
Confirmation
Progress
Error
EmptyState
```

The registry MUST be extensible.

---

# 13. Capability Model

Capabilities represent actions/data sources available to the experience.

```typescript
interface Capability {
  id: string;

  name: string;

  description: string;

  inputSchema: JSONSchema;

  outputSchema: JSONSchema;

  permissions: PermissionRequirement[];

  risk: "none" | "low" | "medium" | "high" | "critical";

  execution:
    | "local"
    | "remote"
    | "agent"
    | "workflow";

  streaming: boolean;
}
```

MCP tools MAY implement capabilities.

A capability MUST NOT be assumed to be equivalent to an MCP tool.

---

# 14. Data Dependencies

Data dependencies MUST be explicitly represented.

```typescript
interface DataDependency {
  id: string;

  source: CapabilityReference;

  input: Record<string, unknown>;

  outputBinding: string;

  mode:
    | "eager"
    | "deferred"
    | "streaming"
    | "onDemand";

  cachePolicy?: CachePolicy;

  refreshPolicy?: RefreshPolicy;
}
```

The Rendering Runtime MUST NOT independently discover arbitrary data sources.

---

# 15. Experience IR

Experience IR is the normalized intermediate representation consumed by the Rendering Runtime.

It MUST contain:

```text
semantic structure
data bindings
interaction bindings
visibility
layout intent
accessibility intent
lifecycle
platform hints
```

Example:

```json
{
  "type": "metric",
  "id": "conversion-rate",
  "semanticRole": "primary-metric",
  "label": {
    "key": "checkout.conversion_rate",
    "fallback": "Conversion rate"
  },
  "data": {
    "binding": "checkout.conversion"
  },
  "interaction": {
    "onSelect": "investigate_conversion"
  }
}
```

---

# 16. Rendering IR

Rendering IR is platform-oriented but still renderer-independent.

```typescript
interface RenderingNode {
  id: string;

  type: RenderingNodeType;

  semanticSource: string;

  properties: Record<string, unknown>;

  layout: LayoutSpec;

  children?: string[];

  events?: RenderingEventBinding[];

  accessibility?: AccessibilitySpec;
}
```

Rendering IR MUST NOT expose implementation-specific React internals.

---

# 17. Rendering Runtime

The Rendering Runtime MUST expose:

```typescript
interface RenderingRuntime {
  mount(
    experience: ExperienceIR,
    context: RenderingContext
  ): RenderHandle;

  patch(
    patch: RenderingPatch
  ): void;

  stream(
    stream: AsyncIterable<ExperienceUpdate>
  ): void;

  suspend(
    experienceId: string
  ): void;

  resume(
    experienceId: string
  ): void;

  unmount(
    experienceId: string
  ): void;
}
```

---

# 18. Rendering Context

Rendering context includes:

```typescript
interface RenderingContext {
  platform: Platform;

  viewport?: Viewport;

  device?: DeviceCapabilities;

  theme: Theme;

  locale: Locale;

  accessibility: AccessibilityPreferences;

  inputCapabilities: InputCapabilities;

  network?: NetworkCharacteristics;

  performanceBudget?: PerformanceBudget;
}
```

---

# 19. Platform Renderer Contract

Every renderer MUST implement:

```typescript
interface PlatformRenderer {
  initialize(context: RenderingContext): void;

  render(
    renderingTree: RenderingNode[]
  ): PlatformRenderHandle;

  patch(
    patch: RenderingPatch
  ): void;

  measure(
    nodeId: string
  ): Measurement;

  dispose(): void;
}
```

Initial renderers:

1. Web/React
2. Web/Angular
3. Flutter
4. Native
5. Slack
6. Teams

The first implementation MAY support only Web/React.

The renderer abstraction MUST NOT prevent additional surfaces.

---

# 20. Mutation Protocol

Experience mutation is a first-class operation.

```typescript
interface ExperienceMutation {
  id: string;

  experienceId: string;

  baseVersion: number;

  operation:
    | "add"
    | "remove"
    | "replace"
    | "update"
    | "move"
    | "bind"
    | "unbind";

  target?: string;

  payload: unknown;

  source:
    | "user"
    | "agent"
    | "application"
    | "system";
}
```

The runtime MUST reject mutations based on stale versions unless the mutation can be safely rebased.

---

# 21. Example Mutation

Agent discovers a new cause:

```json
{
  "operation": "add",
  "target": "checkout-investigation",
  "payload": {
    "type": "insight",
    "id": "payment-failure-insight",
    "title": "Payment failures increased",
    "severity": "high"
  }
}
```

The Experience Runtime:

```text
validate
   ↓
authorize
   ↓
apply
   ↓
increment version
   ↓
emit ExperienceChanged
   ↓
compile rendering delta
   ↓
send rendering patch
```

---

# 22. Rendering Patch

Rendering patches MUST be incremental.

```typescript
interface RenderingPatch {
  experienceId: string;

  fromVersion: number;

  toVersion: number;

  operations: RenderingPatchOperation[];
}
```

Supported operations:

```text
insert
remove
replace
update
move
show
hide
bind
unbind
```

---

# 23. Progressive Rendering

The runtime MUST support progressive construction.

Example:

```text
T0
Render shell

T1
Render primary metrics

T2
Render charts

T3
Render agent-generated insight

T4
Render recommended actions
```

Each stage MUST be independently renderable.

The user MUST NOT need to wait for the complete experience graph before useful content can appear.

---

# 24. Streaming

Streaming MUST support:

* partial data,
* partial experience,
* agent observations,
* incremental mutations,
* rendering patches,
* progress,
* cancellation.

Example:

```text
ExperienceCreated
        ↓
NodeAdded
        ↓
DataStarted
        ↓
DataChunk
        ↓
DataChunk
        ↓
InsightAdded
        ↓
ActionAdded
        ↓
ExperienceStable
```

---

# 25. Rendering Scheduler

The Rendering Runtime MUST prioritize rendering work.

Minimum priority classes:

```text
P0: user interaction
P1: visible content
P2: viewport-near content
P3: background updates
P4: speculative content
```

The scheduler MUST support:

* cancellation,
* coalescing,
* batching,
* prioritization,
* starvation prevention.

---

# 26. Semantic Component Registry

The runtime MUST provide a registry:

```typescript
interface SemanticComponentRegistry {
  register(
    definition: SemanticComponentDefinition
  ): void;

  resolve(
    semanticType: string,
    context: RenderingContext
  ): ComponentImplementation;
}
```

Example:

```text
Semantic: Trend

Web desktop
→ LineChart

Web mobile
→ Sparkline

Slack
→ Textual trend summary

Voice
→ Spoken trend
```

The canonical experience MUST remain `Trend`.

---

# 27. Design System Integration

The Rendering Runtime MUST support design-system constraints.

A renderer MUST receive:

```text
Theme
Typography
Spacing
Colors
Components
Motion
Accessibility
Brand constraints
```

AI-generated experiences MUST NOT arbitrarily invent visual styles when a governed design system is available.

---

# 28. Accessibility

Accessibility MUST be semantic-first.

The Experience Model MUST allow semantic information such as:

```text
role
label
description
importance
navigation relationship
action meaning
status
```

The Rendering Runtime MUST map these to platform-specific accessibility APIs.

Accessibility MUST NOT be treated as an after-the-fact DOM transformation.

---

# 29. Localization

Experience nodes MUST support localization keys with fallback text.

Example:

```json
{
  "label": {
    "key": "database.latency.title",
    "fallback": "Database latency"
  }
}
```

The fallback MUST always remain available.

Translation resources MUST be independently deployable from the Experience Model.

---

# 30. User Interaction Model

Interactions MUST be semantic.

Example:

```typescript
{
  action: "investigate",
  target: "payment-failure"
}
```

The runtime resolves this to a capability/action.

The renderer MUST NOT directly execute privileged capabilities.

Instead:

```text
User interaction
      ↓
Rendering Runtime
      ↓
Experience Runtime
      ↓
Authorization
      ↓
Capability
      ↓
Execution
```

---

# 31. Agent Interaction Model

Agents MAY:

* create experiences,
* add semantic nodes,
* update experience state,
* propose mutations,
* create investigations,
* add actions,
* remove irrelevant content,
* change layout intent,
* request additional capabilities.

Agents MUST NOT directly mutate:

* DOM,
* React state,
* native widget state,
* renderer internals.

---

# 32. Agent Proposal vs Automatic Mutation

The system MUST support both:

### Automatic

Low-risk mutations can be applied automatically.

Example:

```text
Add discovered metric.
```

### Approval Required

High-impact mutations require user approval.

Example:

```text
Execute remediation action.
```

The Experience Runtime MUST distinguish:

```text
experience mutation
```

from:

```text
business action
```

These are separate authorization domains.

---

# 33. Experience Lifecycle

An experience MUST support:

```text
CREATED
  ↓
PLANNING
  ↓
MATERIALIZING
  ↓
ACTIVE
  ↓
UPDATING
  ↓
SUSPENDED
  ↓
RESUMED
  ↓
COMPLETED
  ↓
DESTROYED
```

The runtime MUST support persistence at any lifecycle point where application requirements demand it.

---

# 34. Persistence

Persistent experiences MUST be serializable.

Serialization MUST include:

```text
experience identity
intent
context references
experience version
experience graph
state
capability references
data dependency definitions
policies
lifecycle state
```

It MUST NOT require serialization of:

* DOM,
* React Fiber,
* platform widget instances,
* browser event handlers.

---

# 35. Hydration

A persisted experience MUST be reconstructable without re-running the original agent planning step.

```text
Persisted Experience
        ↓
Experience Runtime
        ↓
Experience IR
        ↓
Rendering Runtime
        ↓
Platform
```

The system MAY optionally re-enter planning when explicitly required.

---

# 36. Multi-Surface Rendering

The same Experience Model MUST be renderable across multiple surfaces.

Example:

```text
Experience
    │
    ├── Browser
    │
    ├── Mobile
    │
    ├── Slack
    │
    ├── Teams
    │
    └── Embedded
```

Surface-specific differences MUST be handled by rendering capabilities.

The application SHOULD NOT maintain separate business logic for every surface.

---

# 37. Surface Capability Negotiation

Before rendering, the runtime MUST negotiate:

```text
supported semantic components
interaction model
layout capabilities
streaming support
input modalities
accessibility features
maximum payload
viewport
network characteristics
```

Example:

```json
{
  "platform": "slack",
  "supports": [
    "text",
    "buttons",
    "sections",
    "tables"
  ],
  "doesNotSupport": [
    "interactive_chart"
  ]
}
```

The rendering runtime MUST select an appropriate representation.

---

# 38. Web Rendering Architecture

Initial web implementation:

```text
Experience IR
      ↓
Web Rendering Compiler
      ↓
React Rendering Tree
      ↓
React
      ↓
DOM
```

React SHOULD be treated as an implementation detail of the Rendering Runtime.

The application MUST NOT depend directly on React for canonical experience semantics.

---

# 39. React Renderer Requirements

The React renderer MUST:

* translate Rendering IR into React elements,
* maintain stable node identity,
* support incremental patches,
* preserve local UI state where semantically valid,
* support streaming,
* support lazy loading,
* support virtualization,
* support accessibility,
* expose renderer telemetry.

---

# 40. Angular Renderer Requirements

Angular MAY be implemented as a second renderer.

It MUST consume the same Rendering IR.

No Experience Runtime logic may be duplicated inside the Angular renderer.

---

# 41. Performance Requirements

The runtime MUST optimize for:

### Initial Experience Time

Time from intent accepted to first meaningful experience.

### First Useful Render

Time until user can perform a meaningful action.

### Mutation Latency

Time from experience mutation accepted to visible update.

### Interaction Latency

Time from user interaction to corresponding experience update.

### Streaming Efficiency

Amount of useful UI delivered per unit of time.

---

# 42. Performance Budgets

The system SHOULD define budgets such as:

```text
First useful render:
< 1 second where data permits

Simple mutation:
< 100ms client-side

Local interaction:
< 50ms target

Rendering patch:
< 100ms for typical updates
```

Exact production SLOs MUST be established through benchmarking.

---

# 43. Zero-Cost-When-Unused

The runtime MUST avoid imposing significant overhead on applications that do not require dynamic experience capabilities.

Specifically:

* static experiences MUST NOT require an agent,
* persisted experiences MUST NOT require re-planning,
* simple rendering MUST NOT invoke expensive semantic processing,
* streaming MUST be opt-in,
* advanced mutation infrastructure SHOULD be lazy-loaded where possible.

---

# 44. Security Model

Security MUST operate at multiple layers:

```text
User Intent
     ↓
Experience Mutation Authorization
     ↓
Capability Authorization
     ↓
Execution Authorization
```

A user being allowed to modify an experience MUST NOT imply permission to execute every capability represented in that experience.

Capability execution MUST continue to enforce application-level authorization.

---

# 45. Provenance

Every agent-generated experience mutation SHOULD include provenance:

```typescript
interface MutationProvenance {
  source: "user" | "agent" | "system" | "application";

  agentId?: string;

  modelId?: string;

  reasoningReference?: string;

  timestamp: number;

  triggeringEvent?: string;
}
```

This is required for debugging and auditability.

---

# 46. Observability

The runtime MUST emit structured events.

Minimum event classes:

```text
ExperienceCreated
ExperienceLoaded
ExperienceMutated
ExperiencePersisted
ExperienceResumed

RenderingStarted
RenderingCompleted
RenderingFailed
RenderingPatched

InteractionStarted
InteractionCompleted
InteractionFailed

CapabilityRequested
CapabilityCompleted
CapabilityFailed
```

Telemetry MUST include:

```text
experienceId
experienceVersion
nodeId
renderer
platform
latency
mutation source
capability
error
```

---

# 47. Deterministic Replay

The runtime MUST support replay of experience evolution.

Given:

```text
initial Experience
+
ordered Experience Events
```

the runtime SHOULD reconstruct the same Experience State.

This is important for:

* debugging,
* incident investigation,
* testing,
* user-session reproduction,
* evaluation of agent behavior.

---

# 48. Testing Requirements

Testing MUST exist at multiple layers.

## 48.1 Experience Tests

Test:

```text
intent → experience
mutation → state
state → experience graph
```

without a renderer.

## 48.2 Rendering Tests

Test:

```text
Experience IR → Rendering IR
```

without a browser.

## 48.3 Renderer Tests

Test:

```text
Rendering IR → platform output
```

## 48.4 Mutation Tests

Test:

```text
mutation
→ validation
→ authorization
→ application
→ patch
```

## 48.5 Replay Tests

Given an event sequence, verify deterministic reconstruction.

## 48.6 Cross-Surface Tests

Verify that the same experience produces valid output on:

```text
Web
Mobile
Slack
Teams
```

---

# 49. Failure Handling

The runtime MUST distinguish:

```text
Experience failure
Rendering failure
Capability failure
Data failure
Agent failure
Platform failure
```

A capability failure MUST NOT necessarily destroy the experience.

Example:

```text
Database latency
      ↓
Metric succeeds
      ↓
Query analysis fails
      ↓
Experience remains usable
      ↓
Error node appears
```

The runtime SHOULD degrade gracefully.

---

# 50. Offline / Disconnected Behavior

Where applicable, the Rendering Runtime SHOULD continue displaying the latest valid Experience State when connectivity is lost.

The renderer MUST distinguish:

```text
stale data
```

from:

```text
invalid data
```

---

# 51. Caching

Caching SHOULD exist at multiple layers:

```text
Capability result cache
Experience state cache
Experience IR cache
Rendering IR cache
Platform resource cache
```

Cache invalidation MUST be explicit.

---

# 52. Versioning

The following MUST be versioned independently:

```text
Experience schema
Experience IR
Rendering IR
Semantic component definitions
Platform renderer contract
Capability schemas
Mutation protocol
```

Backward compatibility MUST be maintained for persisted experiences.

---

# 53. Developer API

The developer-facing API SHOULD look approximately like:

```typescript
const experience = runtime.create({
  intent: {
    objective: "Investigate database latency"
  }
});

experience.bindCapability(
  databaseMetrics
);

experience.addNode({
  type: "Trend",
  id: "latency"
});

experience.mount({
  surface: "web"
});
```

The developer SHOULD NOT need to directly construct React components for canonical experience definition.

---

# 54. Agent API

Agent APIs SHOULD expose semantic operations:

```typescript
agent.experience.add(...)
agent.experience.remove(...)
agent.experience.update(...)
agent.experience.replace(...)
agent.experience.bind(...)
agent.experience.observe(...)
```

The agent MUST NOT receive direct access to renderer internals.

---

# 55. Renderer API

Renderer developers implement:

```typescript
interface Renderer {
  supports(
    node: ExperienceNode,
    context: RenderingContext
  ): boolean;

  compile(
    node: ExperienceNode,
    context: RenderingContext
  ): RenderingNode;

  patch(
    patch: RenderingPatch
  ): void;
}
```

---

# 56. Registry Architecture

The system SHOULD maintain registries for:

```text
Semantic Components
Capabilities
Renderers
Platforms
Themes
Interaction Types
Layouts
Accessibility Adapters
```

Registry entries MUST be versioned.

---

# 57. Example End-to-End Flow

User:

> "Why did database latency increase yesterday?"

### Step 1 — Intent

```text
Intent
  objective = investigate database latency
  timeframe = yesterday
```

### Step 2 — Capability discovery

```text
metrics.read
logs.search
query.analyze
database.top_queries
```

### Step 3 — Experience creation

```text
Investigation
 ├── latency trend
 ├── error rate
 ├── top queries
 └── investigation area
```

### Step 4 — Render

```text
Experience IR
      ↓
Rendering IR
      ↓
React
      ↓
Browser
```

### Step 5 — Agent discovers anomaly

```text
Payment query latency +73%
```

### Step 6 — Experience mutation

```text
add Insight:
"Payment query latency increased 73%"
```

### Step 7 — Rendering patch

Only the affected portion of the experience is updated.

### Step 8 — User interaction

User selects:

```text
Investigate query
```

### Step 9 — Capability execution

```text
Experience Runtime
      ↓
Authorization
      ↓
Capability
      ↓
Loom
      ↓
Execution
```

### Step 10 — New information

The experience graph evolves again.

---

# 58. Reference Repository Structure

The implementation SHOULD initially be organized as:

```text
experience-runtime/
│
├── core/
│   ├── experience/
│   ├── intent/
│   ├── context/
│   ├── state/
│   ├── graph/
│   ├── capability/
│   ├── mutation/
│   ├── lifecycle/
│   └── policy/
│
├── ir/
│   ├── experience-ir/
│   └── rendering-ir/
│
├── runtime/
│   ├── planner/
│   ├── mutation-engine/
│   ├── lifecycle-manager/
│   ├── persistence/
│   └── event-store/
│
├── rendering/
│   ├── compiler/
│   ├── scheduler/
│   ├── streaming/
│   ├── patching/
│   ├── accessibility/
│   └── adaptation/
│
├── registries/
│   ├── components/
│   ├── capabilities/
│   ├── renderers/
│   └── platforms/
│
├── renderers/
│   ├── react/
│   ├── angular/
│   ├── flutter/
│   ├── native/
│   ├── slack/
│   └── teams/
│
├── sdk/
│   ├── client/
│   ├── agent/
│   └── developer/
│
└── observability/
    ├── events/
    ├── metrics/
    └── tracing/
```

---

# 59. Phase 1 — Foundation

Phase 1 SHOULD establish:

1. Experience Model.
2. Experience Graph.
3. Experience State.
4. Capability Model.
5. Experience IR.
6. Rendering IR.
7. Mutation protocol.
8. Experience lifecycle.
9. React renderer.
10. Rendering patch mechanism.
11. Basic persistence.
12. Telemetry.
13. Deterministic replay.

The initial implementation SHOULD avoid multi-agent complexity.

---

# 60. Phase 2 — Dynamic Experience

Add:

* agent-driven mutations,
* streaming,
* progressive rendering,
* deferred nodes,
* rendering scheduler,
* capability discovery,
* semantic component registry,
* adaptive layouts,
* accessibility semantics,
* localization.

---

# 61. Phase 3 — Multi-Surface Runtime

Add:

* Flutter renderer,
* native renderer,
* Slack renderer,
* Teams renderer,
* surface capability negotiation,
* cross-surface state synchronization.

---

# 62. Phase 4 — Advanced Runtime

Add:

* speculative rendering,
* predictive prefetching,
* experience branches,
* collaborative experiences,
* multi-agent experiences,
* experience snapshots,
* distributed experience state,
* intelligent rendering optimization.

---

# 63. Acceptance Criteria

The implementation is considered successful when the following scenario works end-to-end:

```text
User:
"Investigate why checkout conversion dropped."

        ↓

Agent

        ↓

Experience Runtime

        ↓

Experience Graph

        ↓

Experience IR

        ↓

Rendering Runtime

        ↓

React Renderer

        ↓

Browser
```

The agent then discovers a new cause:

```text
Payment failures increased 38%.
```

The agent MUST be able to produce:

```text
Experience Mutation
```

which results in:

```text
Experience State v2
        ↓
Rendering Patch
        ↓
Only affected UI updates
```

without:

* regenerating the entire application,
* generating React source code,
* restarting the page,
* invoking an LLM inside the renderer.

The same Experience Model MUST subsequently be renderable through another supported surface without changing the underlying business/experience semantics.

---

# 64. Architectural Invariants

The following MUST be treated as architectural invariants:

### I1 — Experience is platform independent

The canonical experience MUST NOT depend on React, Angular, Flutter, DOM, or native UI.

### I2 — Rendering is deterministic

The renderer MUST NOT require an LLM.

### I3 — Agent is semantic

Agents operate on experience semantics rather than platform UI trees.

### I4 — Execution is separate

Experience composition MUST NOT replace the execution runtime.

### I5 — Mutation is first-class

Experiences MUST be incrementally mutable.

### I6 — Experience state is distinct from rendering state

Platform-specific UI state MUST NOT become canonical application state.

### I7 — Capability execution is independently authorized

UI mutation does not imply capability execution authorization.

### I8 — Experience is replayable

Experience evolution MUST be observable and reconstructable.

### I9 — Multiple surfaces share semantics

Surface-specific renderers MUST NOT require duplicated application logic.

### I10 — Zero-cost when unused

Static experiences MUST NOT incur unnecessary agent/runtime overhead.

---

# 65. Core Architectural Thesis

The architecture intentionally moves the frontend abstraction hierarchy from:

```text
Application
    ↓
Component Tree
    ↓
React / Angular
    ↓
DOM
```

to:

```text
Application
    ↓
Intent
    ↓
Experience
    ↓
Experience Graph
    ↓
Experience IR
    ↓
Rendering IR
    ↓
Platform Renderer
    ↓
React / Angular / Flutter / Native / Chat
```

The purpose is not to eliminate existing frontend frameworks.

The purpose is to **move them below the semantic boundary of the application**.

React and Angular remain valuable rendering technologies.

The Experience Runtime becomes responsible for the higher-level problem:

> **What should the user experience be, given intent, context, capabilities, state, policies, and continuously arriving information?**

The Rendering Runtime becomes responsible for:

> **How should that experience be materialized, updated, adapted, and interacted with on this particular surface?**

This separation is the foundation for an AI-native frontend architecture in which the UI is not merely generated once, but is a continuously evolving projection of application intent and state.
