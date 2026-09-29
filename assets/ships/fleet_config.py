"""Shared configuration for the openCycle ship fleet pipeline.

Single source of truth for paths, the artist-authored coordinate frame, the
fleet slot order, the vendor source lookup and every budget/limit the stages
assert against. Every stage imports this via sys.path so names and coordinates
never drift between import, finish, bake and validate.

COORDINATE FRAME (authored in Blender, exported with export_yup=False):
    forward = -Z (nose)        aft = +Z (engine nozzles, plumes trail +Z)
    up      = +Y (deck)        wings spread along  X
The GLB therefore drops straight into three r185 with no re-orientation. Each
hull is scaled to TARGET_LENGTH nose-to-tail and its bounding-box centre sits on
the origin, so the game places hulls by centre.

CONTRACT WITH THE GAME (apps/web/src/game/world/fleet.ts):
    nodes      `Ship` root mesh; children `nozzleL`, `nozzleR` (nozzle mouths,
               plumes trail +Z from them), `coreMount` (hull centroid) and the
               optional `bridgeGlass` (omitted when the vendor mesh exposes no
               canopy material - it does not for any current hull)
    material   ONE material named `ship`, four maps at TEX pixels:
                 basecolor  sRGB   RGB = livery, ALPHA = accent mask
                 normal     linear greebles + panel lines
                 orm        linear R = AO, G = roughness, B = metallic
                 emissive   sRGB   engine rims only
               The identity accent rides the basecolor ALPHA channel: mix the
               basecolor RGB toward the rider's identity colour by that alpha.
    budgets     tris <= TRI_BUDGET, GLB <= GLB_MAX_BYTES, textures <= TEX

The finish is deterministic: every seeded choice (greeble picks, palette mix,
decal jitter) uses hashSeed(hull id) so a re-run reproduces the same asset.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))

VENDOR = os.path.join(HERE, "vendor", "quaternius-ultimate-spaceships")
WORK_DIR = os.path.join(HERE, "work")
BAKE_DIR = os.path.join(HERE, "bake")
RENDER_DIR = os.path.join(HERE, "renders")
GLB_DIR = os.path.join(REPO, "apps", "web", "public", "assets", "ships")

for _d in (WORK_DIR, BAKE_DIR, RENDER_DIR, GLB_DIR):
    os.makedirs(_d, exist_ok=True)

# --- fleet slots ---------------------------------------------------------
# Slot order is the three.js contract: rider i flies FLEET[i % len(FLEET)].
FLEET = ["striker", "challenger", "zenith", "insurgent"]
# Tried in order when a default hull fails the silhouette criteria.
SUBSTITUTES = ["spitfire", "omen", "bob"]
CANDIDATES = FLEET + SUBSTITUTES

# --- the raider (pursuit enemy on burn legs) ------------------------------
# Not part of the rider fleet: it is its own GLB, built from the unused vendor
# hull whose chase-camera silhouette reads furthest from the fleet (measured
# pairwise IoU against striker/challenger/zenith/insurgent: spitfire 0.35 mean,
# bob 0.45, omen 0.47 - lowest is most distinct).
RAIDER_ID = "raider"
RAIDER_HULL = "spitfire"
BUILD_ORDER = FLEET + [RAIDER_ID]
# The pursuit is watched from the chase camera at about this range, so the
# raider proof render is framed there rather than on the fleet's 38% target.
RAIDER_CHASE_DIST = 80.0

# --- per-hull build budget ----------------------------------------------
TARGET_LENGTH = 9.0          # world units nose-to-tail
# Atlas size. The plan names 2048, but these maps ship as lossless PNG inside a
# 3 MB GLB: measured at 2048 the four maps are 6.9 MB (basecolor 2.7 + normal
# 2.5 + orm 1.3 + emissive 0.1), which no amount of smoothing fixes because the
# normal map is legitimately detailed. At 1024 the same maps are 2.7 MB and the
# hull still renders ~350 px wide on a 1920 frame, i.e. ~3 texels per screen
# pixel. 1024 it is.
TEX = 1024
# The base colour is a flat paint field (the concept frame's hull material is a
# single flat colour plus the identity accent), so its RGB is low-passed to this
# many texels before it is written; the accent mask on its alpha stays at atlas
# resolution.
BASECOLOR_FIELD = 128
TRI_BUDGET = 60_000
GLB_MAX_BYTES = 3 * 1024 * 1024

# --- silhouette criteria (game camera: 3/4 rear chase) -------------------
MIN_LENGTH_SPAN_RATIO = 1.6  # length >= 1.6 * wingspan
MIN_REAR_ENGINES = 2         # at least two rear engine face islands

# --- named nodes (the three.js contract) --------------------------------
NODE_HULL = "Ship"
NODE_GLASS = "bridgeGlass"
NODE_NOZZLE_L = "nozzleL"
NODE_NOZZLE_R = "nozzleR"
NODE_CORE = "coreMount"
REQUIRED_NODES = [NODE_HULL, NODE_NOZZLE_L, NODE_NOZZLE_R, NODE_CORE]
OPTIONAL_NODES = [NODE_GLASS]

# --- finish: livery palette ---------------------------------------------
# Neutral service livery: the vendor's colour field is pulled toward these two
# neutrals by luminance, and only its boldest texels survive as the accent mask
# (basecolor alpha) that the game tints with the rider identity colour.
GUNMETAL = (0x8D, 0x93, 0x9C)
BONE = (0xC9, 0xC3, 0xB6)
LIVERY_SATURATION = 0.20     # keep only 20% of the source colour: a neutral hull
# The accent is TRIM. Measured on the vendor textures, a fixed 0.45 saturation
# cut selects 4.5-25% of the atlas, and those texels are the flanks, so the
# accent covered 38-78% of the visible hull and the finish read as camo. The cut
# is therefore per hull: the boldest ACCENT_TARGET_COVERAGE of its texels, never
# below ACCENT_SAT_FLOOR.
ACCENT_TARGET_COVERAGE = 0.04
# The baked atlas coverage is what the eye actually sees, so it is the number
# that is guarded: the bake searches the saturation cut and keeps the one whose
# coverage lands closest to the target.
ACCENT_ATLAS_TARGET = 0.05
ACCENT_ATLAS_MIN = 0.02
ACCENT_ATLAS_MAX = 0.08
ACCENT_SAT_FLOOR = 0.45
# The saturated field is cut to bands along the hull: the mockup's accent is a
# stripe around the fuselage plus trim, not whole painted flanks.
ACCENT_BAND_CENTRES = (0.24, 0.50, 0.76)
ACCENT_BAND_WIDTH = 0.55     # world units along the hull
# Per-hull overrides: insurgent's vendor texture is almost fully desaturated, so
# the standard cut leaves it with almost no identity trim.
ACCENT_OVERRIDES = {
    "insurgent": {"target": 0.30, "band": 3.0},
    "zenith": {"target": 0.12, "band": 1.1},
}
EMISSIVE_RING_INNER = 0.85   # outer 15% border of the engine island lights up
EMISSIVE_INTERIOR_HEX = 0x0D0D10   # ... and the nozzle interior stays dark

ACCENT_RECOLOR_SAT = 0.18    # stored accent RGB stays near-neutral; alpha carries it
AO_FLOOR = 0.55              # AO darkens crevices, never whole panels

# --- finish: surface detail ---------------------------------------------
# The vendor hulls are dense smooth triangulations: measured on the four fleet
# hulls only 6-40 edges exceed 35 degrees, so an angle-limited bevel produces no
# visible panel lines at all (it is still applied - it rounds those few hard
# edges - and the panel lines themselves are baked into the same normal map from
# the procedural object-space pattern below). The 0.6% area share named in the
# plan selects 0-19 faces on these meshes, i.e. almost no greebles, so the share
# is calibrated to 0.06% which selects the ~250-430 largest deck/flank faces.
GREEBLE_FACE_AREA_FRAC = 0.0006
GREEBLE_NORMAL_CONE_DEG = 30.0   # ... within this cone of +Y / +-X
GREEBLE_PICK_FRACTION = 0.25     # seeded share of those faces that get a greeble
GREEBLE_INSET = 0.18
GREEBLE_EXTRUDE_FRAC = 0.02      # x length
GREEBLE_RECESS_FRACTION = 1 / 3  # share of greebles that get a second recess
GREEBLE_RECESS_INSET = 0.40
GREEBLE_MAX = 160                # hard cap so the tri budget stays comfortable
PANEL_SHARP_DEG = 35.0           # edge split angle for the bevel
PANEL_BUMP_STRENGTH = 0.35       # procedural panel-line grooves / micro noise
PANEL_LINE_SPACING = 0.62        # world units between girth panel lines
PANEL_LINE_WIDTH = 0.022
WEAR_ROUGH_LO = 0.35
WEAR_ROUGH_HI = 0.70
# 0.60 read as black panels under any dim environment (nothing for the metal
# to reflect); 0.15 keeps a painted-metal feel and a light hull.
HULL_METALLIC = 0.15
ACCENT_METALLIC = 0.10
EMISSIVE_REAR_FRAC = 0.03        # rearmost 3% of faces ...
EMISSIVE_CONE_DEG = 36.9         # ... whose normal is within ~37 deg of +Z
# Only the outer ring of those faces glows (a nozzle rim); the nozzle interior
# stays dark and the game adds the plume. A whole aft plate glowing read as a
# white rectangle, so the emissive is also capped below clipping.
EMISSIVE_MAX = 0.85              # ceiling baked into the emissive map
ENGINE_GLOW_HEX = 0xFFE6C8       # engine rim emissive (warm white)
EMISSIVE_BOOST_RENDER = 1.6      # render-only emissive boost for the proofs
ENGINE_ISLAND_MIN_AREA = 0.03    # island share of the aft-facing area
ENGINE_ISLAND_MIN_SEP = 0.15     # island separation as a share of span
ENGINE_SINGLE_OFFSET = 0.12      # single engine -> +-this * span

# --- finish: texture bake sizes (px on the 2048 atlas) ------------------
TEX_BASECOLOR = "basecolor"
TEX_NORMAL = "normal"
TEX_ORM = "orm"
TEX_EMISSIVE = "emissive"

IDENTITY_HEX = ["#5b8cff", "#ff7a6b", "#f5c542", "#4fd1c5"]


def source_hull(build_id):
    """Build id -> vendor hull: the raider borrows an unused hull."""
    return RAIDER_HULL if build_id == RAIDER_ID else build_id


def source_dir(hull_id):
    return os.path.join(VENDOR, source_hull(hull_id).capitalize())


# --- deterministic seeding ------------------------------------------------
# Mirrors packages/shared/src/random.ts (FNV-1a + mulberry32) so the finish is
# reproducible from the hull id alone, the same way the game's seeded names are.
def hash_seed(s):
    h = 2166136261
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def mulberry32(seed):
    """Generator of floats in [0, 1)."""
    a = seed & 0xFFFFFFFF

    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return nxt


def work_blend(hull_id):
    return os.path.join(WORK_DIR, f"{hull_id}.blend")


def work_blend_stage(hull_id, stage):
    return os.path.join(WORK_DIR, f"{hull_id}.{stage}.blend")


def glb_path(hull_id):
    return os.path.join(GLB_DIR, f"{hull_id}.glb")


def bake_path(hull_id, kind):
    return os.path.join(BAKE_DIR, f"{hull_id}_{kind}.png")


def render_path(hull_id):
    return os.path.join(RENDER_DIR, f"{hull_id}_game.png")


# --- per-build finish overrides -------------------------------------------
# The raider is a dark, matte, hostile machine rather than a service livery.
FINISH_OVERRIDES = {
    RAIDER_ID: {
        "gunmetal": 0x2E3138,       # shadowed plate
        "bone": 0x3A3D44,           # lit plate
        "liverySat": 0.10,
        "roughLo": 0.55,
        "roughHi": 0.75,
        "metal": 0.15,
        "accentMetal": 0.10,
        "accentTarget": 0.025,
        "accentBand": 0.5,
        "glow": 0xFF9A5C,           # hot amber engine rims, not the fleet's cool white
        "dark": 0x15161A,
    },
}


def finish_opts(build_id):
    """Resolved finish numbers: defaults, with the raider's overrides on top."""
    o = FINISH_OVERRIDES.get(build_id, {})
    return {
        "gunmetal": o.get("gunmetal", (GUNMETAL[0] << 16) | (GUNMETAL[1] << 8) | GUNMETAL[2]),
        "bone": o.get("bone", (BONE[0] << 16) | (BONE[1] << 8) | BONE[2]),
        "liverySat": o.get("liverySat", LIVERY_SATURATION),
        "roughLo": o.get("roughLo", WEAR_ROUGH_LO),
        "roughHi": o.get("roughHi", WEAR_ROUGH_HI),
        "metal": o.get("metal", HULL_METALLIC),
        "accentMetal": o.get("accentMetal", ACCENT_METALLIC),
        "accentTarget": o.get("accentTarget", ACCENT_TARGET_COVERAGE),
        "accentBand": o.get("accentBand", ACCENT_BAND_WIDTH),
        "glow": o.get("glow", ENGINE_GLOW_HEX),
        "dark": o.get("dark", EMISSIVE_INTERIOR_HEX),
    }


def source_path(hull_id):
    """First match of **/<Name>*.gltf|*.glb, else *.blend, else *.fbx."""
    import glob

    base = source_dir(hull_id)
    if not os.path.isdir(base):
        return None
    cap = source_hull(hull_id).capitalize()
    for pat in (f"**/{cap}*.gltf", f"**/{cap}*.glb", f"**/{cap}*.blend", f"**/{cap}*.fbx"):
        hits = sorted(glob.glob(os.path.join(base, pat), recursive=True))
        if hits:
            return hits[0]
    return None


def hex_rgb(h):
    """'#rrggbb' -> (r, g, b) floats 0..1 (sRGB-encoded, as authored)."""
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
