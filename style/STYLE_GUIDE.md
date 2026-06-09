# Green Cross Price-Card Style Guide

**Purpose:** one consistent way to name every product, so cards read the same across all
six stores. Derived from your master template (`MasterTemplate_060426`, 431 cards). This is
the reference that powers in-app **autocomplete** and **smart-naming**. Companion data file:
[`tags.json`](./tags.json).

> ✅ **Reviewed & confirmed** (2026-06-09). Naming decisions signed off: Yocan (official spelling),
> Decibel Farms (merged), Dave's Nuttz (two t's), weights stay verbatim (no leading zero).
> Update as the catalog evolves.

---

## 1. Card field schema

Every card is built from these fields, in this order:

| Field | What it is | Example |
|---|---|---|
| **Brand** | Canonical brand (see §2) | `Farmer's Friend` |
| **Product** | Product / line name | `Live Resin Cart`, `Rosin Gummies 1:1` |
| **Description 1** | Strain or type + potency | `Various \| 100mg THC` |
| **Description 2** | *(optional)* secondary ratio/potency | `25mg THC \| CBD` |
| **Size** | Weight or count (§4) | `1g`, `10 Pieces`, `Each` |
| **Price** | `$` + number | `$22` |
| **Category** | One of 10 (§5) | `EDIBLE` |

---

## 2. Brand names — canonical list

Use the **full, correctly-spelled** brand every time (the [`tags.json`](./tags.json) `brands`
list has all 83). Multi-word brands are written in full — never the wrapped fragment.

**Corrections the dictionary auto-applies** (source → canonical):

| In your template | Canonical | Why |
|---|---|---|
| `Entrourage` | **Entourage** | typo |
| `Precission` | **Precision** | typo |
| `Yocam` / `YoCan` | **Yocan** | typo + official-spelling fix (confirmed) |
| `Farmer's` (wrapped) | **Farmer's Friend** | line-wrap in PDF |
| `High Desert` (wrapped) | **High Desert Pure** | line-wrap |
| `Portland` (wrapped) | **Portland Heights** | line-wrap |
| `National` (wrapped) | **National Cannabis Co.** | line-wrap |
| `Willamette` / `…Alchemey` | **Willamette Valley Alchemy** | line-wrap + "Alchemey" misspelling |
| `Harmony` (wrapped) | **Harmony Roots** | line-wrap |
| `Dave's Nuttz` / `Dave's Nutz` | **Dave's Nuttz** | two spellings unified — two t's (confirmed) |
| `Decibel` / `Decibel Farms` | **Decibel Farms** | one brand across extracts + pre-rolls (confirmed) |

**Apostrophes:** store as straight `'` (e.g. `Farmer's`) for reliable matching; display unchanged.

**Accessories exception:** many accessory cards lead with the *item type* (`Glass Pipe`, `Dab Rig`,
`Grinder`) rather than a brand — that's expected. Real accessory brands (`Puffco`, `Yocan`, `Wulf`,
`Pulsar`, `Randy's`, `Hemper`, `Rokin`…) are used when the item is branded. ~28 generic item-types
were excluded from the brand list.

---

## 3. Description / potency formatting

- **Potency:** `<number>mg <CANNABINOID>` — e.g. `100mg THC`, `500mg CBD`. No space inside `100mg`.
- **Multiple cannabinoids:** join with ` | ` → `25mg THC | CBD`, `100mg THCV | CBG | CBD`.
- **Mixed strains:** lead with `Various` → `Various | 100mg THC`. Use `Mixed Ratios` for blends.
- **Ratios:** colon, no spaces → `1:1`, `1:1:1`, `4:1`, `6:1`.
- **Cannabinoid tokens (uppercase):** `THC`, `CBD`, `CBG`, `CBN`, `THCV`.

---

## 4. Size / count formatting

- **Weights:** number + lowercase unit, no space → `1g`, `2g`, `3.5oz`, `12oz`, `750ml`.
  - Fractional weights stay as written, **no leading zero** → `.75g` (less is more).
- **Counts:** `1 Piece` (singular) / `10 Pieces` (plural); packs `2 Pack`, `10 Pack`, `40 Pack`.
- **Accessories / single units:** `Each`.
- **All-in-one vapes:** `All-in-One` as the size line where applicable.
- Typo caught: `.12 Pack` → **`12 Pack`**.

---

## 5. Categories (the 10 sections)

`EDIBLE` · `BEVERAGE` · `VAPE` · `DISPOSABLE` · `EXTRACT` · `PRE ROLLS` · `TINCTURES` ·
`TOPICALS` · `ACCESSORIES` · `BRANDS`

Counts in your template: Accessories 151, Edible 49, Beverage 49, Pre-Rolls 47, Extract 29,
Tinctures 28, Disposable 24, Brands 24, Vape 19, Topicals 11.

---

## 6. Multi-price cards (the `BRANDS` page pattern)

Some cards show several price points for several sizes on one card, e.g.
`$30 | $60 | $150` paired with `Pipe | Bong | XL Bong`. This is a distinct card type —
noted for the "copies / variants per card" feature, not the standard single-price layout.

---

## 7. How smart-naming will use this

When a product comes in (typed by staff, or pulled from Dutchie), the app will:
1. Match the **brand** to the canonical list (fixing the corrections above).
2. Normalize **potency / ratio / size** to the formats in §3–4.
3. Suggest the conformed card name; staff accept or tweak.

This is what keeps the six stores' cards uniform.
