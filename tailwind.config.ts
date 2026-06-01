import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

/*
  Story 1.4 Visual Foundation — full semantic token set.
  Apostle Paul Memorial Park brand application (Tier 1 visual theming).

  All tokens are derived from the UX § Visual Design Foundation tables
  and the Apostle Paul brand guide (chapters III Colour, IV Typography,
  V Logo system).

  - Brand palette: emerald (institutional voice), ivory (environment),
    stone (neutrals), gold (rationed accent — hairlines + monogram inlay
    only, never as fill), moss / forest (support surfaces).
  - Semantic palette wires `primary` to Emerald, `surface` to Ivory,
    `text` to Ink/Stone.
  - Status palette: 7 lot states + 5 payment states are SEMANTIC, not
    brand — they remain unchanged (overdue red, available emerald, etc).
  - Cormorant Garamond / Manrope / JetBrains Mono are loaded in
    `src/app/layout.tsx` via `next/font/google` and exposed as the
    `--font-cormorant`, `--font-manrope`, `--font-jetbrains-mono` CSS
    variables.
  - Outdoor mode swaps a small set of CSS custom properties defined in
    `src/app/globals.css` under `:root[data-theme="outdoor"]`.

  Disaster prevention reminders:
  - No raw hex values outside this file + globals.css.
  - Gold (#C9A96B / #D4BC85) is RATIONED. Use only for hairlines,
    masthead dividers, and monogram inlay — never as fill, never as
    focus ring (focus ring uses emerald).
  - Status pills are light-tint background + dark text + colored icon.
    Never `bg-emerald-600 text-white` style dark-fill.
*/
const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#1D5C4D", // Apostle Paul Emerald
          hover: "#144437", // Emerald-deep
          fg: "#F6F2EA", // Ivory
        },
        surface: {
          base: "#FFFFFF", // pure white kept — ivory is muted
          muted: "#F6F2EA", // Ivory
          border: "#E1DAC8", // Ivory-deep-border (hairline rule colour)
          emphasis: "#EDE7DA", // Ivory-deep
        },
        text: {
          default: "#2A2925", // Ink (never pure black)
          muted: "#8E8C85", // Stone-dark
          subtle: "#B8B6AF", // Stone
        },
        "focus-ring": "#1D5C4D", // Emerald (gold is rationed — never used here)
        flash: "#fffbeb", // amber-50 — ReactiveHighlight tint (kept; not a brand surface)
        destructive: {
          DEFAULT: "#b91c1c", // red-700 (semantic; brand-compatible)
          fg: "#ffffff",
        },
        accent: {
          // RATIONED — hairlines, masthead dividers, monogram inlay only.
          // Never use as background or focus ring.
          gold: "#C9A96B",
          "gold-soft": "#D4BC85",
        },
        support: {
          // Secondary surfaces (sidebar accents, ceremonial labels, etc).
          moss: "#4A8270",
          forest: "#2F6B57",
        },
        status: {
          // Lot states (7) — SEMANTIC, unchanged.
          available: {
            bg: "#ecfdf5", // emerald-50
            text: "#064e3b", // emerald-900
            icon: "#059669", // emerald-600
            border: "#047857", // emerald-700 (outdoor mode)
          },
          reserved: {
            bg: "#fffbeb", // amber-50
            text: "#78350f", // amber-900
            icon: "#d97706", // amber-600
            border: "#b45309", // amber-700
          },
          sold: {
            bg: "#f1f5f9", // slate-100
            text: "#334155", // slate-700
            icon: "#475569", // slate-600
            border: "#64748b", // slate-500
          },
          occupied: {
            bg: "#f5f5f4", // stone-100
            text: "#292524", // stone-800
            icon: "#44403c", // stone-700
            border: "#57534e", // stone-600
          },
          cancelled: {
            bg: "#f4f4f5", // zinc-100
            text: "#52525b", // zinc-600
            icon: "#71717a", // zinc-500
            border: "#a1a1aa", // zinc-400
          },
          defaulted: {
            bg: "#fef2f2", // red-50
            text: "#7f1d1d", // red-900
            icon: "#dc2626", // red-600
            border: "#b91c1c", // red-700
          },
          transferred: {
            bg: "#eef2ff", // indigo-50
            text: "#312e81", // indigo-900
            icon: "#4f46e5", // indigo-600
            border: "#4338ca", // indigo-700
          },
          // Payment / installment states (5) — SEMANTIC, unchanged.
          paid: {
            bg: "#ecfdf5",
            text: "#064e3b",
            icon: "#059669",
            border: "#047857",
          },
          current: {
            bg: "#f1f5f9",
            text: "#334155",
            icon: "#475569",
            border: "#64748b",
          },
          due: {
            bg: "#fffbeb",
            text: "#78350f",
            icon: "#d97706",
            border: "#b45309",
          },
          overdue: {
            bg: "#fef2f2",
            text: "#7f1d1d",
            icon: "#dc2626",
            border: "#b91c1c",
          },
          // Intentionally less alarming than `overdue` — covers Mr. Reyes's
          // "this is being handled" bucket distinction.
          "overdue-action": {
            bg: "#fffbeb",
            text: "#78350f",
            icon: "#d97706",
            border: "#b45309",
          },
          // Contract lifecycle (Story 5.9 — sweep raw status spans).
          // `active` shares the slate-current palette ("work in progress"
          // operational tone). `paid_in_full` mirrors the `paid` emerald
          // family (terminal success). `voided` mirrors `cancelled` (muted
          // zinc — terminal but not alarming). `in_default` mirrors the
          // `defaulted` red family.
          active: {
            bg: "#f1f5f9",
            text: "#334155",
            icon: "#475569",
            border: "#64748b",
          },
          paid_in_full: {
            bg: "#ecfdf5",
            text: "#064e3b",
            icon: "#059669",
            border: "#047857",
          },
          voided: {
            bg: "#f4f4f5",
            text: "#52525b",
            icon: "#71717a",
            border: "#a1a1aa",
          },
          in_default: {
            bg: "#fef2f2",
            text: "#7f1d1d",
            icon: "#dc2626",
            border: "#b91c1c",
          },
          // Interment lifecycle (Story 7.1). `scheduled` reuses the
          // `reserved` amber family (awaiting an event). `completed`
          // mirrors `paid` emerald (terminal success).
          scheduled: {
            bg: "#fffbeb",
            text: "#78350f",
            icon: "#d97706",
            border: "#b45309",
          },
          completed: {
            bg: "#ecfdf5",
            text: "#064e3b",
            icon: "#059669",
            border: "#047857",
          },
          // Expense approval queue (Story 6.6).
          approved: {
            bg: "#ecfdf5",
            text: "#064e3b",
            icon: "#059669",
            border: "#047857",
          },
          pending_approval: {
            bg: "#fffbeb",
            text: "#78350f",
            icon: "#d97706",
            border: "#b45309",
          },
          rejected: {
            bg: "#fef2f2",
            text: "#7f1d1d",
            icon: "#dc2626",
            border: "#b91c1c",
          },
        },
      },
      fontFamily: {
        // Display serif — Cormorant Garamond — headings + ceremonial
        // copy (masthead wordmark, page H1s, hero copy).
        display: [
          "var(--font-cormorant)",
          "Georgia",
          "serif",
        ],
        // Body sans — Manrope — wayfinding, body copy, operational text.
        sans: [
          "var(--font-manrope)",
          ...defaultTheme.fontFamily.sans,
        ],
        // Mono — JetBrains Mono — codes, tabular numerics, eyebrows.
        mono: [
          "var(--font-jetbrains-mono)",
          ...defaultTheme.fontFamily.mono,
        ],
      },
      letterSpacing: {
        // Brand-spec tracking for ceremonial copy. Used on the masthead
        // wordmark and capital-set labels per the brand guide.
        ceremonial: "0.16em",
        "wide-mark": "0.36em",
      },
      borderWidth: {
        // Outdoor mode swaps `--pill-border-width` from 0 → 2px via the
        // CSS variable defined in globals.css. Consumers use
        // `border-pill` (length-driven via arbitrary value in the
        // component itself) — this entry exists so the var is referenced
        // somewhere in the config.
        pill: "var(--pill-border-width, 0px)",
      },
      keyframes: {
        "flash-fade": {
          "0%": { backgroundColor: "var(--color-flash, #fffbeb)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
      animation: {
        // ReactiveHighlight applies this when its `watch` prop changes.
        // Duration is overridden inline per-instance via `animationDuration`.
        "flash-fade": "flash-fade var(--flash-duration, 600ms) ease-out forwards",
      },
      transitionDuration: {
        // StatusPill color crossfade. Globally suppressed by the
        // prefers-reduced-motion rule in globals.css.
        status: "300ms",
      },
    },
  },
  plugins: [],
};

export default config;
