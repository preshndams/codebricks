# CodeBricks — Shared Design Rules

> This file is the single source of truth for design principles across all frontend platforms.
> Platform skills extend these rules; they never override them.
> Load this FIRST, together with `security-baseline.md`. Then apply platform-specific rules on top.

---

## The Laws (non-negotiable, always applied)

**Law 1 — Generic is worse than ugly.**
A deliberately styled interface with a strong point of view beats a neutral template every time. Bland is not safe — it is invisible. Make a visual decision and commit to it.

**Law 2 — One composition per viewport.**
One focal point, one dominant idea, one primary action in every screen's visible area. The eye needs a hierarchy, not a democracy.

**Law 3 — Brand first. Brand test.**
Before marking anything done, ask: "Could this belong to any other product?" If yes, it's not done. Brand must be present in color, type, motion, and voice — not just a logo in the corner.

**Law 4 — Purpose before pixels.**
Before writing any code, establish: What is this screen FOR? Who uses it? What is the one thing they must be able to do? What emotion should it evoke? What makes it distinctively ours?

---

## Design Thinking Pre-Flight

Run this before coding any screen or component:

```
1. PURPOSE    — What is the user's job to be done here?
2. TONE       — What should this feel like? (calm/urgent/playful/authoritative/warm)
3. CONSTRAINT — What must be preserved? (existing design system, brand colors, accessibility requirements)
4. DIFFERENTIATOR — What makes this NOT look like a template?
5. VISUAL THESIS  — One sentence: "This screen communicates _____ through _____."
```

If you cannot answer all five, do not start building.

---

## Pre-Flight Checklist (run before every session)

- [ ] Is there a `CODEBRICKS.md` in the project root? → Read it. It overrides defaults.
- [ ] Is there a `questionnaire.md` in the project root? → Read it. It captures project preferences.
- [ ] Is there a `screenshots/` directory? → Load every image as design reference. Match the visual intent.
- [ ] Is there an existing design system or component library? → Preserve it. Do not introduce conflicts.
- [ ] What platform am I targeting? → Load the correct platform skill on top of these shared rules.

---

## Typography Rules

**Banned for display/heading use:** Inter, Roboto, SF Pro, System UI as a deliberate choice.
These are fine as body fallbacks. They are not acceptable as the typographic voice of a product.

**Required:** A distinctive typeface that reflects the product's personality. Choose from:
- **Geometric expressive**: Space Grotesk, Cabinet Grotesk, Syne, General Sans
- **Humanist warm**: Plus Jakarta Sans, Outfit, Nunito, DM Sans
- **Editorial / authority**: Fraunces, Playfair Display, Lora, Cormorant
- **Technical precision**: JetBrains Mono, Fira Code, IBM Plex Mono
- **Classic grotesque**: Neue Haas Grotesk, Aktiv Grotesk (if licensed)

**Rules:**
- Maximum 2 typefaces. If you use 2, they must have a clear role (display vs. body, or heading vs. UI label).
- Size contrast must be dramatic. If your largest and smallest text are within 4px of each other, the hierarchy is broken.
- Weight range must be used. Light/Regular for body, Semibold/Bold/Black for display. No single-weight designs.
- Line-height for body copy: 1.5–1.7. Never below 1.4 for paragraphs.
- Letter-spacing for ALL-CAPS labels/overlines: `0.08em–0.12em`. For body: 0 or `-0.01em`.

---

## Color Rules

**No flat, single-color backgrounds.**
Every background surface must have depth: a subtle gradient, a noise texture, a mesh gradient, a soft radial, or a tinted surface. Flat #FFFFFF or flat #0A0A0A as the only background treatment = template. At minimum, use an off-white (#FAFAFA, #F5F5F0) or a tinted dark (#0D0F13).

**One accent color as default.** Two is an advanced choice that requires intentional contrast and hierarchy. Three or more requires a design system, not a skill invocation.

**Tokens, never hardcoded values.** No hex color appears in component code. Every color is a CSS custom property, a Tailwind token, a theme token, or a ThemeExtension. If you see `color: '#3B82F6'` in component code, that is a bug.

**Semantic colors are not optional:**
- Success: a green (not just "tick mark icon")
- Warning: an amber (never red — red is for errors)
- Error: a red with a distinct surface (`--color-error-surface`)
- Info: a blue or brand-adjacent tint

**Dark mode is never an afterthought.** If dark mode is in scope, both themes are designed and tested. A dark mode that is just `background: #000` with white text is not dark mode — it is an incident.

---

## Composition & Layout Rules

**Hero sections:**
- Full-bleed only on landing/marketing pages.
- Maximum content: brand, headline, one supporting sentence, one CTA, one image.
- No stat tiles ("10M users", "99.9% uptime") overlaid on hero imagery.
- No badge clusters or icon grids floating over background imagery.
- Overlays are acceptable for text legibility only — not decoration.

**Cards:**
- Use a card only when the card IS the interaction container (clickable, selectable, expandable).
- Do not use cards to visually organize non-interactive information. That is what spacing and typography hierarchy are for.
- Strip borders and shadows if they do not signal interactivity. Unnecessary chrome is noise.

**First viewport:**
- The first thing a user sees must answer: "What is this, and what can I do?" in under 3 seconds.
- Never lead with a feature grid, card carousel, or testimonial section.
- One visual anchor (image, illustration, bold type treatment) per first viewport. Not three.

**Spacing:**
- Use a base-8 scale consistently. 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 80 / 96.
- No magic numbers. No `padding: 13px` or `margin: 7px`.
- Generous whitespace is a design decision, not wasted space. Dense UIs need intentional density — not accident.

---

## Motion Rules

**Ship 2–3 intentional animations. Remove everything else.**

The three motions worth keeping:
1. **Entrance** — how the primary content arrives on screen
2. **Scroll effect** — one parallax, reveal, or sticky behaviour
3. **Hover / press transition** — interactive state feedback

Animations that are purely decorative and serve no communication purpose: remove them. Every animation must answer "what does this communicate to the user?"

**Always respect `prefers-reduced-motion`.** This is non-negotiable, not optional. Wrap motion with a reduced-motion media query or equivalent platform check.

**Speed:**
- Micro-interactions (hover, press): 100–150ms
- State transitions (modal, drawer, dropdown): 200–300ms
- Page-level transitions: 300–500ms
- Anything over 500ms feels broken unless it is a deliberate cinematic moment with purpose

---

## Anti-Patterns: The Banned List

These patterns are identified, called out, and corrected. No exceptions.

| Pattern | Why it fails |
|---|---|
| Inter or Roboto as the only typeface | No personality. Invisible brand. Template output. |
| Purple-to-blue gradient on white | The default "AI-generated" aesthetic. Immediately recognisable as generic. |
| Hero section with floating stat tiles | Clutters the focal point. Undermines the headline. |
| Card grid as the first impression | Information architecture as decoration. No composition. |
| Multiple stacked content carousels | Users do not scroll carousels. Each one is hidden content. |
| Beautiful imagery + weak/no branding | Stock photo energy. Could be any company. |
| Flat background with no depth treatment | Flat UI that does not choose to be flat — it just forgot. |
| Empty state = blank white area | Not designed. Ship skeleton/empty state alongside the happy path. |
| Loading state = full-page spinner | Not designed. Use skeleton screens that mirror the content layout. |
| Error state = raw error string | Not designed. Write a message. Give a recovery action. |
| Colour-only distinction for status | Inaccessible. Pair colour with icon or text label always. |
| `console.log` in committed code | Not production standard. Use a logger or remove it. |
| Magic number spacing (`padding: 13px`) | Not a system. Cannot be maintained. Replace with scale token. |

---

## Validation Checklist (run before marking any task done)

- [ ] **Brand test**: could this UI belong to any other product? If yes, it is not done.
- [ ] **Single composition**: is there one clear visual anchor in the first viewport?
- [ ] **Typography distinctiveness**: is a non-default typeface in use with real weight contrast?
- [ ] **Background depth**: is the background more than a flat solid colour?
- [ ] **No banned anti-patterns** from the list above present?
- [ ] **All states designed**: loading, error, empty, and success — not just the happy path?
- [ ] **Responsive correctness**: tested at 360px mobile and 1280px desktop minimum?
- [ ] **Motion budget respected**: 2–3 intentional animations, none purely ornamental?
- [ ] **`prefers-reduced-motion` respected**?
- [ ] **Tokens, not hardcoded values**: no hex codes or px values in component files?
- [ ] **Dark mode** (if in scope): does it look designed, not just inverted?
- [ ] **Accessibility**: interactive elements keyboard-reachable? Minimum contrast met?

---

## How Platform Skills Use This File

Each platform skill (`/codebricks:react`, `/codebricks:nextjs`, `/codebricks:react-native`, `/codebricks:flutter`) inherits every rule in this document and then adds:
- Framework-specific technical stack requirements
- Platform-specific component patterns
- Framework-specific anti-patterns
- Platform-specific performance non-negotiables
- Framework-specific tooling and test requirements
- Platform-specific security controls (on top of `security-baseline.md`)

If a platform skill conflicts with this file, this file wins. Security rules in `security-baseline.md` win over both.
