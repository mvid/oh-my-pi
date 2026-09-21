# DS4 directional-steering automation

Plan only. Nothing here is implemented. Written 2026-09-21 against `antirez/ds4`
`main` and this checkout's `tau` branch. Execute on a machine that can actually
run the models (see Hardware).

## Why

Weight abliteration sets `W' = W - d dᵀ W`, which yields `y' = y - d(d·y)` for
every write into the residual stream. That is the `scale = 1` case of a runtime
activation edit. Doing it at runtime is a superset: the scale is free and signed,
it applies per component, and it is reversible by restarting without the vector.

It also avoids the quantization round trip. Editing a QAT'd, pre-quantized model
means dequantize, subtract a rank-1 term, requantize, which discards the
calibration and lets requantization error partially reconstitute the direction
that was removed. A separate f32 direction file has neither problem. For DeepSeek
V4 Flash the file is 43 x 4096 f32, roughly 700 KB against a multi-GB GGUF.

ds4 already implements the runtime edit. What is missing is a measured way to
choose a vector and a scale.

## Verified upstream state

From `dir-steering/README.md`:

- Edit is `y = y - scale * direction[layer] * dot(direction[layer], y)`, applied
  after FFN outputs, attention outputs, or both.
- Flags: `--dir-steering-file FILE`, `--dir-steering-ffn F` (default 1 when a
  file is given), `--dir-steering-attn F` (default 0).
- Shapes: DeepSeek V4 Flash `43 x 4096`, GLM 5.3 Flash `45 x 4096` (MTP
  predictor omitted), Qwen3.8 Flash Next `48 x 2560`.
- GLM 5.2 steering is not implemented. Qwen steering is Metal-only and leaves
  the embedded MTP predictor unsteered.
- Positive scale suppresses the extracted direction, negative amplifies it.

From `dir-steering/tools/build_direction.py`:

- Activation capture runs through the real inference graph via
  `DS4_METAL_GRAPH_DUMP_PREFIX`, `DS4_METAL_GRAPH_DUMP_NAME`,
  `DS4_METAL_GRAPH_DUMP_POS`, taking the last prompt-token row per layer.
- Difference of means over pairs, with `--pair-normalize` to average normalized
  per-pair differences instead.
- Control-mean orthogonalization is on by default; `--no-orthogonalize` disables
  removing the component parallel to the control mean.
- Pure stdlib (`array`, `math`), no numpy. `MODEL_PROFILES` is a hardcoded
  `(n_layer, n_embd)` table with three entries.
- One `ds4` subprocess per prompt with `-n 1` and a full prefill, so a 100-pair
  run is 200 process launches.

From `dir-steering/tools/run_sweep.py`:

- Iterates prompts x scales, shells out to `ds4`, prints to stdout. No parsing,
  no classifier, no metric, no selection rule.

From `docs/SERVER.md`:

- Endpoints are `GET /v1/models`, `POST /v1/chat/completions`,
  `POST /v1/responses`, `POST /v1/completions`, `POST /v1/messages`.
- Steering is configured at process start. No per-request steering field is
  documented, so a client cannot vary it per message; it selects a steered server.

## Hardware

From the ds4 README: Metal is the primary target on Macs with 96 GB or more, with
SSD streaming for smaller machines; NVIDIA CUDA including DGX Spark and multi-GPU
setups such as L40S; ROCm on Strix Halo. Capture as written serially reloads the
model per prompt, so M2 matters more on slower storage.

## Scope

Goals:

- A scored sweep that emits machine-readable rows instead of prose.
- An objective function and a search over scale that a machine can run unattended.
- Reproducible artifacts that name the direction, the prompt sets, the model, and
  the scores that justified the chosen scale.
- omp orchestration of the loop, and a first-class `ds4` provider so steered and
  unsteered servers are selectable seats.

Non-goals:

- Modifying or redistributing weights.
- Publishing vectors from this repo. ds4 already treats `.f32` outputs as local
  artifacts; keep them out of git.
- Putting activation math anywhere in omp. omp never sees activations and must
  not grow a forward pass.

## Architecture

Three layers, cleanly separated:

1. **Engine.** ds4, unchanged, owns the activation edit and the capture dumps.
2. **Measurement.** A scoring wrapper around the sweep that turns generations into
   rows. Lives next to the ds4 checkout, or upstream as a PR if antirez wants it.
3. **Orchestration.** An omp extension package: a custom tool wrapping the ds4
   CLI, a workpool over candidate scales, a judge for scoring, an evidence record
   binding inputs to outputs. No omp core changes.

## Milestones

### M1. Scored sweep

Wrap `run_sweep.py` so each `(prompt, scale)` emits one JSON row: prompt id,
scale, component, generated text, a refusal flag, and a retention score. Fixed
`--temp 0` for determinism. Held-out prompt sets, never the extraction pairs.

Acceptance: a sweep over 6 scales and 20 prompts produces 120 rows with no
missing fields, and rerunning it byte-identically reproduces the flags.

### M2. Batched capture

Replace the one-process-per-prompt loop with a single process capturing many
prompts, or drive `ds4-server --batched-session`.

Acceptance: 100 pairs complete with one model load, and the resulting `.f32` is
byte-identical to the serial path on the same inputs.

### M3. Objective and search

Maximize refusal-removal on the held-out set subject to a floor on capability
retention. Bisect the single FFN scalar first; treat the per-layer scale vector
as a later experiment, not part of this milestone.

Acceptance: the loop selects a scale unattended, and the chosen scale matches a
human reading of the same rows on at least one worked example. The artifact JSON
records both sides of the objective, not just the winner.

### M4. omp orchestration package

Extension package with:

- A custom tool wrapping build, sweep, and score (`packages/coding-agent/src/extensibility/custom-tools/types.ts`
  for the factory contract).
- A workpool fanning scale candidates, since each candidate is an independent
  process and the cost is inference.
- Multi-voice judging for the retention half. Refusal detection agrees across
  judges; "did it get dumber" does not, which is the failure mode single-judge
  scoring hides. The panel resolver (`resolvePanelLineup`, `packages/coding-agent/src/panel/runtime.ts`)
  already resolves a family-distinct lineup and returns a lineup hash.
- A hash-bound evidence record: vector hash, GGUF hash, prompt-set hashes, scale,
  scores, judge lineup hash.

Acceptance: one command runs extraction through selection on the big machine and
writes an evidence record a second operator can re-verify without rerunning.

### M5. `ds4` provider descriptor

Register a `ds4` provider so a local `ds4-server` is a named seat rather than
hand-rolled model config.

Pin it to `api: "openai"` against `/v1/chat/completions`. This is load-bearing,
not a preference: the `extra-body` compat axis is scoped to
`records: ["openai"]` (`packages/catalog/src/compat/axes.ts:99`, where
`OAI = ["openai", "openai-responses"]` at :42), and the Responses path reads
caller-supplied `options?.extraBody` (`packages/ai/src/providers/openai-responses.ts:1337`)
rather than the resolved compat record, which is what the chat-completions path
does (`packages/ai/src/providers/openai-completions.ts:1891`). A Responses-API
descriptor therefore gets no KDL-authored extra body. The bundled `abliteration`
descriptor is `api: "openai-responses"`, so copying it is exactly the trap.

Work: add the entry to `CATALOG_PROVIDERS` in
`packages/catalog/src/provider-models/descriptors.ts`, add a
`packages/catalog/src/compat/rules/providers/ds4.kdl` block, run
`bun run gen:compat`, commit `rules.json` alongside.

Acceptance: `omp models` lists ds4 models from a running local server, and a
steered and unsteered server are separately addressable as models or panel seats.

### M6. Per-request steering (upstream dependent)

If ds4 grows a request-body steering field, the omp side is a KDL `extra-body`
rule plus `gen:compat`, given M5's pinning. Precedents:
`compat/rules/providers/deepseek.kdl:8`,
`compat/rules/providers/alibaba-token-plan.kdl:41`. Blocked until upstream
exposes it; do not add a client-side knob for something the server fixes at load.

Widening the axis to `OAI` instead is a real change, not a one-liner: it also
needs the Responses path to merge `compat.extraBody` with a defined precedence
against `options.extraBody`. Out of scope here.

## Open empirical questions

Each is cheap on a machine that can run the models, and none has a published
answer I am aware of.

1. **Quant transfer.** A direction extracted from Q2 activations applied to Q4 of
   the same model. If it does not transfer, vectors are per-quant artifacts.
2. **Layer-wise scale.** One global FFN scale across 43 layers versus a per-layer
   profile. Optimizing 43 scalars is a different search problem.
3. **Rank-1 sufficiency.** Refusal is probably not cleanly rank-1. Measure what a
   second direction buys before building multi-direction machinery.
4. **Component choice.** `ffn_out` versus `attn_out` versus both, at matched
   effect size. README calls attention steering more fragile; quantify it.
5. **Pair-set saturation.** Where the 100-pair example stops improving.
6. **Capture mode.** `--think` versus `--nothink` capture, and whether a vector
   built one way holds under the other.

## Risks

- Judge drift on the retention half. Mitigated by M4's multi-voice scoring and by
  recording the lineup hash with each verdict.
- Over-strong scales collapse into repetition, per the README's own observation.
  The objective must penalize that, not just count refusals.
- The harness is direction-agnostic by construction. The same loop with different
  pair files optimizes any behavioral direction, and a scored optimizer that
  maximizes compliance is a jailbreak optimizer with extra steps. Artifacts must
  name the direction they encode; that is what the evidence record is for.
- Metal-only paths (Qwen) and unimplemented models (GLM 5.2) limit which targets
  the pipeline can cover. Do not generalize the tooling past the profile table.

## Execution order

M1 first and standalone: once the sweep emits rows, everything else composes on
top. M2 before any large pair set. M5 is independent of M1 through M4 and can
land in parallel. M3 needs M1. M4 needs M1 and M3. M6 is upstream-gated.
