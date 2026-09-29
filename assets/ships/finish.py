"""Stage 2: the custom finish.

    work/<hull>.imported.blend -> work/<hull>.finished.blend

Applied to the flattened vendor hull, deterministically (seed = hull id):

  * panel lines  - a clamped bevel on every edge sharper than 35 degrees, which
                   the normal bake turns into a panel-line groove
  * greebles     - seeded insets + extrusions on the large flat deck/flank
                   faces, one third of them with a second recessed panel
  * livery       - the vendor's bold colour fields desaturated 35% of the way
                   toward neutral gunmetal/bone, so the fleet reads as one
                   service livery instead of five paint jobs
  * accent mask  - source texels above the saturation threshold become the
                   accent mask, carried in the basecolor ALPHA channel; the
                   game tints that mask with the rider identity colour
  * engine rims  - the rearmost faces whose normal points aft are moved to a
                   second design material that emits the engine glow
  * named nodes  - nozzleL / nozzleR at the two outermost rear engine islands,
                   coreMount at the hull centroid, bridgeGlass when the vendor
                   material names expose a canopy

The design materials here are bake sources, not the shipped material: stage 3
flattens them into one atlas and one Principled material.

Run: blender --background --factory-startup --python assets/ships/finish.py -- striker
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import fleet_config as C  # noqa: E402
import numpy as np  # noqa: E402
import render_lib as R  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

GLASS_RE = __import__("re").compile(r"glass|window|cockpit|canopy", __import__("re").I)


# ---------------------------------------------------------------------------
# small node helpers
# ---------------------------------------------------------------------------
def _nt(mat):
    nt = mat.node_tree
    nt.nodes.clear()
    return nt


def _srgb_lin(hex_int):
    """sRGB hex -> linear RGBA tuple (Blender node colour sockets are linear)."""
    r, g, b = ((hex_int >> 16) & 255) / 255.0, ((hex_int >> 8) & 255) / 255.0, (hex_int & 255) / 255.0
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4  # noqa: E731
    return (f(r), f(g), f(b), 1.0)


def _in_sock(node, name, kind, occurrence=0):
    """Socket by (name, type): several nodes repeat a name across data types
    (ShaderNodeMix has a float A/B and an RGBA A/B)."""
    hits = [s for s in node.inputs if s.name == name and s.type == kind]
    return hits[occurrence] if hits else None


def _out_sock(node, name=None, kind=None):
    hits = [s for s in node.outputs if (name is None or s.name == name)
            and (kind is None or s.type == kind)]
    return hits[0] if hits else None


def _mix(nt, fac, a, b, loc=(0, 0), blend="MIX"):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = blend
    n.location = loc
    ns = _in_sock(n, "Factor", "VALUE")
    a_s, b_s = _in_sock(n, "A", "RGBA"), _in_sock(n, "B", "RGBA")
    if isinstance(fac, float):
        ns.default_value = fac
    else:
        nt.links.new(fac, ns)
    for sock, val in ((a_s, a), (b_s, b)):
        if isinstance(val, (tuple, list)):
            sock.default_value = val
        elif isinstance(val, float):
            sock.default_value = (val, val, val, 1.0)
        else:
            nt.links.new(val, sock)
    return _out_sock(n, "Result", "RGBA")


def _math(nt, op, a, b=None, loc=(0, 0), clamp=False, name=None):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.location = loc
    n.use_clamp = clamp
    if name:
        n.name = name
    for idx, val in enumerate((a, b)):
        if val is None:
            continue
        if isinstance(val, (int, float)):
            n.inputs[idx].default_value = float(val)
        else:
            nt.links.new(val, n.inputs[idx])
    return n.outputs["Value"]


# ---------------------------------------------------------------------------
# design materials
# ---------------------------------------------------------------------------
def accent_threshold(albedo, hull_id=None):
    """Per-hull saturation cut for the accent mask: the boldest
    ACCENT_TARGET_COVERAGE of the source texels, never below ACCENT_SAT_FLOOR."""
    target = C.ACCENT_OVERRIDES.get(hull_id, {}).get("target",
             C.finish_opts(hull_id)["accentTarget"])
    w, h = albedo.size
    a = np.empty(w * h * 4, dtype=np.float32)
    albedo.pixels.foreach_get(a)
    rgb = a.reshape(-1, 4)[:, :3]
    mx = rgb.max(axis=1)
    mn = rgb.min(axis=1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    cut = float(np.quantile(sat, 1.0 - target))
    cut = max(C.ACCENT_SAT_FLOOR, cut)
    return cut, float((sat >= cut).mean())


def stripe_band(nt, sep_z, loc, width=None):
    """1 inside the accent bands along the hull, 0 elsewhere. The vendor paints
    whole flanks, so the saturated field alone covers a quarter of the visible
    hull and reads as camo; cutting it to bands is what turns it into trim."""
    z01 = nt.nodes.new("ShaderNodeMapRange")
    z01.location = loc
    z01.clamp = True
    z01.inputs["From Min"].default_value = -C.TARGET_LENGTH * 0.5
    z01.inputs["From Max"].default_value = C.TARGET_LENGTH * 0.5
    z01.inputs["To Min"].default_value = 0.0
    z01.inputs["To Max"].default_value = 1.0
    nt.links.new(sep_z, z01.inputs["Value"])

    half = (width or C.ACCENT_BAND_WIDTH) * 0.5 / C.TARGET_LENGTH
    out = None
    for i, centre in enumerate(C.ACCENT_BAND_CENTRES):
        d = _math(nt, "SUBTRACT", z01.outputs["Result"], centre,
                  loc=(loc[0] + 200, loc[1] - 160 * i))
        ad = _math(nt, "ABSOLUTE", d, loc=(loc[0] + 340, loc[1] - 160 * i))
        band = nt.nodes.new("ShaderNodeMapRange")
        band.location = (loc[0] + 480, loc[1] - 160 * i)
        band.clamp = True
        band.inputs["From Min"].default_value = half
        band.inputs["From Max"].default_value = half * 1.6
        band.inputs["To Min"].default_value = 1.0
        band.inputs["To Max"].default_value = 0.0
        nt.links.new(ad, band.inputs["Value"])
        out = band.outputs["Result"] if out is None else _math(
            nt, "MAXIMUM", out, band.outputs["Result"], loc=(loc[0] + 620, loc[1] - 160 * i))
    return out


def hull_design_material(albedo_img, sat_cut, band_width=None, opts=None):
    """Vendor albedo -> neutral service livery + accent mask (the mask lands in
    the basecolor ALPHA channel at bake time). `opts` carries the per-build
    palette/metal overrides (a raider is dark and matte, not service grey)."""
    o = opts or {}
    mat = bpy.data.materials.new("hull_design")
    nt = _nt(mat)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = albedo_img
    tex.location = (-1400, 200)
    src = tex.outputs["Color"]

    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(src, bw.inputs["Color"])
    bw.location = (-1150, 400)
    lum = _out_sock(bw)          # RGBToBW exposes "Val"

    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-1150, 60)
    nt.links.new(src, sep.inputs["Color"])
    objc = nt.nodes.new("ShaderNodeTexCoord")
    objc.location = (-1400, -300)
    osep = nt.nodes.new("ShaderNodeSeparateXYZ")
    osep.location = (-1220, -300)
    nt.links.new(objc.outputs["Object"], osep.inputs["Vector"])
    mx = _math(nt, "MAXIMUM", sep.outputs["Red"], sep.outputs["Green"], loc=(-980, 120))
    mx = _math(nt, "MAXIMUM", mx, sep.outputs["Blue"], loc=(-860, 120))
    mn = _math(nt, "MINIMUM", sep.outputs["Red"], sep.outputs["Green"], loc=(-980, -20))
    mn = _math(nt, "MINIMUM", mn, sep.outputs["Blue"], loc=(-860, -20))
    chroma = _math(nt, "SUBTRACT", mx, mn, loc=(-740, 60))
    sat = _math(nt, "DIVIDE", chroma, _math(nt, "MAXIMUM", mx, 0.02, loc=(-740, -60)),
                loc=(-620, 60), clamp=True)

    # dark texels resolve to gunmetal, bright texels to bone
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-820, 400)
    ramp.color_ramp.elements[0].position = 0.06
    ramp.color_ramp.elements[0].color = _srgb_lin(o.get("gunmetal", 0x8D939C))
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = _srgb_lin(o.get("bone", C.BONE[0] << 16 | C.BONE[1] << 8 | C.BONE[2]))
    nt.links.new(lum, ramp.inputs["Fac"])

    livery = _mix(nt, o.get("liverySat", C.LIVERY_SATURATION), ramp.outputs["Color"], src,
                  loc=(-520, 300))
    accent_rgb = _mix(nt, C.ACCENT_RECOLOR_SAT, ramp.outputs["Color"], src, loc=(-520, 120))
    mask = nt.nodes.new("ShaderNodeMapRange")
    mask.name = "satMask"
    mask.label = "saturation cut"
    mask.location = (-520, -80)
    mask.clamp = True
    mask.inputs["From Min"].default_value = sat_cut
    mask.inputs["From Max"].default_value = sat_cut + 0.07
    nt.links.new(sat, mask.inputs["Value"])
    band = stripe_band(nt, osep.outputs["Z"], (-1000, -260), width=band_width)
    # the baked accent mask is the saturation cut AND the band
    gated = _math(nt, "MULTIPLY", mask.outputs["Result"], band, loc=(-140, -140), name="mask")
    base = _mix(nt, gated, livery, accent_rgb, loc=(-320, 220))
    nt.links.new(base, bsdf.inputs["Base Color"])

    metal = nt.nodes.new("ShaderNodeMapRange")
    metal.name = "metal"
    metal.label = "metallic"
    metal.location = (-320, 0)
    metal.clamp = True
    metal.inputs["From Min"].default_value = 0.0
    metal.inputs["From Max"].default_value = 1.0
    metal.inputs["To Min"].default_value = o.get("metal", C.HULL_METALLIC)
    metal.inputs["To Max"].default_value = o.get("accentMetal", C.ACCENT_METALLIC)
    nt.links.new(mask.outputs["Result"], metal.inputs["Value"])
    nt.links.new(metal.outputs["Result"], bsdf.inputs["Metallic"])

    bump_normal(nt, bsdf)
    bsdf.inputs["Roughness"].default_value = (o.get("roughLo", C.WEAR_ROUGH_LO)
                                             + o.get("roughHi", C.WEAR_ROUGH_HI)) * 0.5
    bsdf.inputs["Emission Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 0.0
    mat["mask_socket"] = "sat"
    return mat


def _stripe(nt, coord, spacing, width, loc):
    """1 on a thin line every `spacing` units, 0 elsewhere."""
    m = _math(nt, "MODULO", coord, spacing, loc=loc)
    half = _math(nt, "SUBTRACT", m, spacing * 0.5, loc=(loc[0] + 140, loc[1]))
    d = _math(nt, "ABSOLUTE", half, loc=(loc[0] + 280, loc[1]))
    n = nt.nodes.new("ShaderNodeMapRange")
    n.clamp = True
    n.location = (loc[0] + 420, loc[1])
    n.inputs["From Min"].default_value = width
    n.inputs["From Max"].default_value = width * 2.6
    n.inputs["To Min"].default_value = 1.0
    n.inputs["To Max"].default_value = 0.0
    nt.links.new(d, n.inputs["Value"])
    return n.outputs["Result"]


def panel_line_height(nt):
    """Object-space panel-line grooves plus fine surface noise -> a bump height.

    The vendor meshes are smooth triangulations with almost no edges above the
    bevel angle, so the geometric pass cannot carry the panel lines; they are
    generated here and land in the normal map through the normal bake."""
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-1400, -420)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-1220, -420)
    nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
    # girth lines run around the hull (variation along Z) and panel lines along
    # it (variation along X): the two sets read as plates on the deck and flanks.
    z_lines = _stripe(nt, sep.outputs["Z"], C.PANEL_LINE_SPACING, C.PANEL_LINE_WIDTH, (-1040, -320))
    x_lines = _stripe(nt, sep.outputs["X"], C.PANEL_LINE_SPACING * 1.33, C.PANEL_LINE_WIDTH * 0.8,
                      (-1040, -620))
    lines = _math(nt, "MAXIMUM", z_lines, x_lines, loc=(-560, -420))
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-1040, -860)
    noise.inputs["Scale"].default_value = 12.0
    noise.inputs["Detail"].default_value = 3.0
    noise.inputs["Roughness"].default_value = 0.5
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    micro = _math(nt, "MULTIPLY", noise.outputs["Fac"], 0.06, loc=(-860, -860))
    h = _math(nt, "SUBTRACT", micro, lines, loc=(-380, -600))
    return h


def bump_normal(nt, bsdf):
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (-200, -560)
    bump.inputs["Strength"].default_value = C.PANEL_BUMP_STRENGTH
    bump.inputs["Distance"].default_value = 0.06
    nt.links.new(panel_line_height(nt), bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return bump


def engine_dark_material(dark_hex=None):
    """The nozzle interior: near-black, no emission (the rim carries the glow)."""
    mat = bpy.data.materials.new("engine_dark_design")
    nt = _nt(mat)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = _srgb_lin(dark_hex or C.EMISSIVE_INTERIOR_HEX)
    bsdf.inputs["Metallic"].default_value = 0.30
    bsdf.inputs["Roughness"].default_value = 0.55
    bsdf.inputs["Emission Strength"].default_value = 0.0
    return mat


def engine_design_material(glow_hex):
    mat = bpy.data.materials.new("engine_design")
    nt = _nt(mat)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = _srgb_lin(0x23272E)
    bsdf.inputs["Metallic"].default_value = 0.95
    bsdf.inputs["Roughness"].default_value = 0.22
    glow = _srgb_lin(glow_hex)
    bsdf.inputs["Emission Color"].default_value = glow
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


# ---------------------------------------------------------------------------
# geometry finish
# ---------------------------------------------------------------------------
def panel_lines(hull):
    mod = hull.modifiers.new("panel_lines", "BEVEL")
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(C.PANEL_SHARP_DEG)
    mod.width = 0.006 * C.TARGET_LENGTH
    mod.segments = 1
    mod.use_clamp_overlap = True
    mod.harden_normals = False
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.modifier_apply(modifier=mod.name)


def _min_edge(f):
    return min((e.calc_length() for e in f.edges), default=0.0)


def greeble(hull, hull_id, length):
    """Seeded insets + extrusions on the big, outward-facing flat faces.

    Faces too thin for their inset are skipped: an even-offset inset on a sliver
    pushes vertices along an acute angle bisector and throws spikes metres off
    the hull (measured: +1.4 units past striker's nose before this guard)."""
    rng = C.mulberry32(C.hash_seed(hull_id))
    me = hull.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()

    lo = Vector((1e9,) * 3)
    hi = -lo
    for v in bm.verts:
        lo = Vector((min(lo[i], v.co[i]) for i in range(3)))
        hi = Vector((max(hi[i], v.co[i]) for i in range(3)))
    ext = hi - lo
    bbox_surface = 2.0 * (ext.x * ext.y + ext.y * ext.z + ext.z * ext.x)
    thresh = C.GREEBLE_FACE_AREA_FRAC * bbox_surface
    cone = math.cos(math.radians(C.GREEBLE_NORMAL_CONE_DEG))

    def usable(f):
        edges = [e.calc_length() for e in f.edges]
        if not edges:
            return False
        mn, mx = min(edges), max(edges)
        return mn > 1e-6 and mx / mn <= 6.0

    cands = [f for f in bm.faces
             if f.calc_area() >= thresh and _min_edge(f) > 0 and usable(f)
             and (f.normal.y >= cone or abs(f.normal.x) >= cone)]
    thin = [f for f in bm.faces
            if f.calc_area() >= thresh and _min_edge(f) > 0 and not usable(f)
            and (f.normal.y >= cone or abs(f.normal.x) >= cone)]
    cands.sort(key=lambda f: (-round(f.normal.x, 4), -round(f.normal.z, 4), -round(f.calc_area(), 6)))
    pick = [f for f in cands if rng() < C.GREEBLE_PICK_FRACTION][:C.GREEBLE_MAX]
    recess_pick = [f for f in pick if rng() < C.GREEBLE_RECESS_FRACTION]

    extruded, recessed = 0, 0
    for f in pick:
        if not f.is_valid:
            continue
        r = math.sqrt(max(f.calc_area(), 1e-9))
        thick = min(C.GREEBLE_INSET * r, 0.30 * _min_edge(f))
        res = bmesh.ops.inset_individual(
            bm, faces=[f], thickness=thick,
            depth=C.GREEBLE_EXTRUDE_FRAC * length, use_even_offset=True)
        extruded += 1
        inner = res.get("faces") or []
        if f in recess_pick and inner and inner[0].is_valid:
            i0 = inner[0]
            bmesh.ops.inset_individual(
                bm, faces=[i0], thickness=min(C.GREEBLE_RECESS_INSET * r, 0.25 * _min_edge(i0)),
                depth=-0.6 * C.GREEBLE_EXTRUDE_FRAC * length, use_even_offset=True)
            recessed += 1
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    return {"candidates": len(cands), "thinSkipped": len(thin), "greebles": extruded,
            "recesses": recessed, "areaThreshold": round(thresh, 4)}


def ring_faces(hull, islands, face_ids, inner):
    """Keep only the outer ring of an engine island: the nozzle rim glows, the
    mouth behind it stays dark (a full aft plate glowing read as a white bar)."""
    me = hull.data
    ids = set(face_ids)
    keep = set()
    for isl in islands:
        idx = [i for i in isl["indices"] if i in ids]
        if not idx:
            continue
        cx, cy = isl["x"], isl["y"]
        rad = {i: math.hypot(me.polygons[i].center.x - cx,
                             me.polygons[i].center.y - cy) for i in idx}
        rmax = max(rad.values())
        ring = [i for i in idx if rad[i] >= inner * rmax] if rmax > 1e-6 else idx
        keep.update(ring or idx)
    return sorted(keep)


def rear_engine_faces(hull, window_frac, cone_deg):
    """Face indices of the rearmost faces pointing aft (+Z), window widening
    until the selection is non-empty."""
    me = hull.data
    zs = [v.co.z for v in me.vertices]
    zmax, zmin = max(zs), min(zs)
    length = zmax - zmin
    cone = math.cos(math.radians(cone_deg))
    frac = window_frac
    for _ in range(4):
        lim = zmax - frac * length
        hits = [p.index for p in me.polygons if p.center.z >= lim and p.normal.z >= cone]
        if hits:
            return hits, frac
        frac *= 2.0
    return [], frac


def engine_islands(hull, faces):
    """Cluster rear-facing faces by connected topology into engine islands."""
    me = hull.data
    span = max(v.co.x for v in me.vertices) - min(v.co.x for v in me.vertices)
    face_set = set(faces)
    adj = {}
    for i in face_set:
        for ek in me.polygons[i].edge_keys:
            adj.setdefault(ek, []).append(i)
    remaining = set(face_set)
    comps = []
    while remaining:
        seed = remaining.pop()
        stack, comp = [seed], [seed]
        while stack:
            idx = stack.pop()
            for ek in me.polygons[idx].edge_keys:
                for other in adj[ek]:
                    if other in remaining:
                        remaining.discard(other)
                        comp.append(other)
                        stack.append(other)
        comps.append(comp)
    out = []
    for comp in comps:
        area = sum(me.polygons[i].area for i in comp)
        if area <= 0:
            continue
        cen = lambda attr: sum(getattr(me.polygons[i].center, attr) * me.polygons[i].area
                               for i in comp) / area  # noqa: E731
        out.append({
            "x": cen("x"), "y": cen("y"), "z": cen("z"),
            "zMax": max(me.polygons[i].center.z for i in comp),
            "area": area, "faces": len(comp), "indices": comp})
    out.sort(key=lambda c: -c["area"])
    return out, span


def nozzle_nodes(islands, span, centroid):
    """Two outermost rear engine islands, or the single-engine +-0.12*span pair
    when the hull has one engine boss. Nodes sit at the nozzle mouth (the
    rearmost point of the island) so the plumes clear the hull."""
    total = sum(c["area"] for c in islands) or 1.0
    big = [c for c in islands if c["area"] >= C.ENGINE_ISLAND_MIN_AREA * total]
    pair = None
    if len(big) >= 2:
        big.sort(key=lambda c: c["x"])
        if big[-1]["x"] - big[0]["x"] >= C.ENGINE_ISLAND_MIN_SEP * span:
            pair = (big[0], big[-1])
    if pair:
        left, right = pair
        mode = "twin-island"
    else:
        base = islands[0] if islands else {"x": 0.0, "y": centroid.y, "z": centroid.z, "zMax": centroid.z}
        off = C.ENGINE_SINGLE_OFFSET * span
        left = dict(base, x=base["x"] - off)
        right = dict(base, x=base["x"] + off)
        mode = "single-offset"
    return {
        C.NODE_NOZZLE_L: (left["x"], left["y"], left["zMax"]),
        C.NODE_NOZZLE_R: (right["x"], right["y"], right["zMax"]),
    }, mode


def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.4
    e.location = Vector(loc)
    bpy.context.collection.objects.link(e)
    return e


def glass_mesh(hull, glass_faces):
    """Split the canopy out as its own object when the vendor exposes one."""
    bpy.ops.object.select_all(action="DESELECT")
    hull.select_set(True)
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for i in glass_faces:
        hull.data.polygons[i].select = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    before = set(bpy.data.objects.keys())
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    new = [bpy.data.objects[k] for k in bpy.data.objects.keys() if k not in before]
    if not new:
        return None
    glass = new[0]
    glass.name = C.NODE_GLASS
    glass.data.name = C.NODE_GLASS
    return glass


def build(hull_id):
    bpy.ops.wm.open_mainfile(filepath=C.work_blend_stage(hull_id, "imported"))
    hull = bpy.data.objects[C.NODE_HULL]
    bpy.context.view_layer.objects.active = hull
    meta_path = os.path.join(C.WORK_DIR, f"{hull_id}.import.json")
    with open(meta_path) as fh:
        meta = json.load(fh)
    length = C.TARGET_LENGTH

    albedo = None
    for m in hull.data.materials:
        if not m:
            continue
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                albedo = n.image
    if albedo is None:
        raise RuntimeError(f"{hull_id}: vendor albedo texture not found")

    # canopy, when the vendor names one
    glass_faces = []
    for i, p in enumerate(hull.data.polygons):
        mats = [hull.data.materials[p.material_index]] if p.material_index < len(hull.data.materials) else []
        if any(m and GLASS_RE.search(m.name) for m in mats):
            glass_faces.append(i)
    glass = glass_mesh(hull, glass_faces) if glass_faces else None

    panel_lines(hull)
    bpy.ops.object.select_all(action="DESELECT")
    hull.select_set(True)
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.shade_auto_smooth(angle=math.radians(38))
    greebles = greeble(hull, hull_id, length)

    engine_faces, window = rear_engine_faces(hull, C.EMISSIVE_REAR_FRAC, C.EMISSIVE_CONE_DEG)
    islands, span = engine_islands(hull, engine_faces)
    glow_faces = ring_faces(hull, islands, engine_faces, C.EMISSIVE_RING_INNER)

    # materials: 0 = hull design, 1 = engine glow design
    opts = C.finish_opts(hull_id)
    band_width = C.ACCENT_OVERRIDES.get(hull_id, {}).get("band", opts["accentBand"])
    sat_cut, sat_cover = accent_threshold(albedo, hull_id)
    hmat = hull_design_material(albedo, sat_cut, band_width, opts)
    emat = engine_design_material(opts["glow"])
    dmat = engine_dark_material(opts["dark"])
    hull.data.materials.clear()
    for m in (hmat, emat, dmat):
        hull.data.materials.append(m)
    engine_set = set(engine_faces)
    glow_set = set(glow_faces)
    for p in hull.data.polygons:
        p.material_index = 1 if p.index in glow_set else (2 if p.index in engine_set else 0)

    hull.data.calc_loop_triangles()
    co = [hull.matrix_world @ v.co for v in hull.data.vertices]
    centroid = sum(co, Vector((0, 0, 0))) / len(co)

    nodes, engine_mode = nozzle_nodes(islands, span, centroid)
    nodes[C.NODE_CORE] = (centroid.x, centroid.y, centroid.z)

    empties = []
    for name, loc in nodes.items():
        e = empty(name, loc)
        e.parent = hull
        e.matrix_parent_inverse = Matrix.Identity(4)
        empties.append(e)
    if glass is not None:
        glass.parent = hull
        glass.matrix_parent_inverse = Matrix.Identity(4)
        glass.data.materials.clear()
        glass.data.materials.append(hmat)

    bpy.ops.wm.save_as_mainfile(filepath=C.work_blend_stage(hull_id, "finished"))
    lo, hi = R.world_bounds([hull])
    ext = hi - lo
    # The finish may only ever add a greeble's extrusion depth (0.02 * length)
    # to an extent; anything larger means an inset blew up.
    limit = C.GREEBLE_EXTRUDE_FRAC * C.TARGET_LENGTH * 3
    assert abs(ext.z - C.TARGET_LENGTH) <= limit, f"{hull_id}: hull length moved to {ext.z:.2f}"
    expected = Vector((meta["spanX"], meta["upY"], meta["lengthZ"]))
    assert (ext - expected).length <= limit * 2, \
        f"{hull_id}: hull extents drifted to {tuple(round(v, 2) for v in ext)}"
    meta.update({
        "vendorHull": C.source_hull(hull_id),
        "extentsFinished": [round(v, 3) for v in ext],
        "greebles": greebles,
        "engineFaces": len(engine_faces),
        "glowFaces": len(glow_faces),
        "accentSatCut": round(sat_cut, 4),
        "accentAtlasCoverage": round(sat_cover, 4),
        "engineWindowFrac": round(window, 4),
        "engineIslands": [{k: v for k, v in c.items() if k != "indices"} for c in islands],
        "engineMode": engine_mode,
        "nodes": {k: [round(c, 3) for c in v] for k, v in nodes.items()},
        "glass": glass is not None,
        "trisFinished": len(hull.data.loop_triangles) + (len(glass.data.loop_triangles) if glass else 0),
        "albedo": albedo.name,
    })
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True)
    return meta


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for hull_id in (argv or C.BUILD_ORDER):
        meta = build(hull_id)
        print(f">>> {hull_id}: tris={meta['trisFinished']} greebles={meta['greebles']['greebles']}"
              f"/{meta['greebles']['candidates']} engineFaces={meta['engineFaces']}"
              f" islands={len(meta['engineIslands'])} glass={meta['glass']}")


if __name__ == "__main__":
    main()
