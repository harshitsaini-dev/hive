# Hive design system — Claymorphism

The visual language: soft, rounded, tactile surfaces that look pressed out of
clay. Depth comes from layered shadow rather than borders or hard edges.

> **Reconciliation note.** The master plan calls for reusing Orbit's
> Claymorphism token set so both projects share an identity. Those tokens are
> not in this repository, so this file defines an equivalent system from first
> principles. If Orbit's real values turn up, replace the primitives in
> `tokens.css` — every component reads from them, so nothing else needs
> touching.

## What makes it clay, specifically

Three rules. Break any one and it stops reading as clay and starts reading as
generic Material.

1. **Radius is large and consistent.** Nothing sharp. Small controls get
   `--radius-md` (0.75rem), containers get `--radius-lg` (1.25rem), pills get
   `--radius-full`.
2. **Every raised surface carries two shadows**: a soft outer drop shadow for
   lift, and an inset highlight along the top edge for the rounded-lip look.
   One without the other looks flat or looks embossed, not moulded.
3. **Surfaces are tinted, never pure.** No `#fff`, no `#000`. Everything sits
   slightly toward the honey hue so the palette feels like one material.

## Colour

Built around honey/amber, which suits a product called Hive without being
literal about it.

| Role | Light | Dark |
|---|---|---|
| Page ground | `#f4efe4` | `#14120f` |
| Raised surface | `#fbf7ee` | `#211d18` |
| Recessed surface | `#ece5d6` | `#1a1713` |
| Ink | `#2b2620` | `#f3eee4` |
| Muted ink | `#6b6357` | `#a89f92` |
| Accent | `#b8801d` | `#e0a53a` |

Contrast: ink on ground and muted ink on surface both clear 4.5:1 in each
theme. The accent is used for large text, icons and solid buttons — where it
carries small text it does so as `--accent-ink` on a filled accent background,
not as accent-coloured text on a light ground.

## Elevation

Clay depth is a stack, not a single blur.

- `--shadow-raised` — buttons, cards at rest.
- `--shadow-floating` — modals, the bulk action bar.
- `--shadow-pressed` — the inset state for a held button, and for input wells.

Inputs are **recessed** (inset shadow, recessed background); buttons and cards
are **raised**. That opposition is what tells you which things you type into
and which things you press.

## Motion

Short and soft: `--ease-clay` with `--duration-fast` for state changes.
Pressing a button moves it down 1px and swaps to the pressed shadow. Everything
is disabled wholesale under `prefers-reduced-motion`.

## Using it

`tokens.css` defines the primitives and is imported first. Components reference
tokens only — a hard-coded colour, radius or shadow anywhere else is a bug, and
the reason is that swapping in Orbit's palette should be a one-file change.
