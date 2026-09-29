"""Stage 4: validate the exported GLB and render its game-camera proof.

Re-imports `<hull>.glb` in a fresh headless Blender and asserts the three.js
contract (node names, tri budget, texture set and sizes, GLB size, wired PBR
channels), then renders:

    renders/<hull>_game.png   1920x1080 game camera, tinted with the identity
                              colour exactly the way the game tints it
    renders/<hull>_sil.png    the same camera, silhouette only (metrics)

`-- --sheet` assembles renders/fleet_game.png and reports the fleet's silhouette
metrics (per-hull coverage, pairwise overlap) so distinctness is measurable
rather than a matter of opinion.

Run: blender --background --factory-startup --python assets/ships/validate_glb.py -- striker
     blender --background --factory-startup --python assets/ships/validate_glb.py -- --sheet
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import fleet_config as C  # noqa: E402
import render_lib as R  # noqa: E402

SIL_W, SIL_H = 960, 540
# diagnostics (the accent A/B renders) never land in the shipped renders/
TMPDIR = os.path.join("/tmp", "oc_ships")
os.makedirs(TMPDIR, exist_ok=True)


def wipe():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def validate(hull_id):
    wipe()
    path = C.glb_path(hull_id)
    bytes_ = os.path.getsize(path)
    bpy.ops.import_scene.gltf(filepath=path)
    names = {o.name for o in bpy.data.objects}
    missing = [n for n in C.REQUIRED_NODES if n not in names]
    assert not missing, f"{hull_id}: MISSING NODES {missing}"

    tris = 0
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    assert tris <= C.TRI_BUDGET, f"{hull_id}: TRI OVER BUDGET {tris} > {C.TRI_BUDGET}"
    assert bytes_ <= C.GLB_MAX_BYTES, f"{hull_id}: GLB TOO BIG {bytes_} > {C.GLB_MAX_BYTES}"

    imgs = [im for im in bpy.data.images if im.source in {"FILE", "GENERATED"} and im.size[0] > 1]
    for im in imgs:
        assert im.size[0] <= C.TEX and im.size[1] <= C.TEX, f"{hull_id}: TEX TOO BIG {im.name}"
    assert len(imgs) >= 4, f"{hull_id}: expected 4 textures, got {len(imgs)}"

    mat = bpy.data.materials.get("ship") or next(m for m in bpy.data.materials if m.use_nodes)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    wired = {k: bool(bsdf.inputs[k].links)
             for k in ("Base Color", "Metallic", "Roughness", "Normal", "Emission Color")}
    assert wired["Base Color"] and wired["Normal"] and wired["Roughness"], f"{hull_id}: PBR links {wired}"
    return {"tris": tris, "bytes": bytes_,
            "textures": sorted(f"{im.name}:{im.size[0]}" for im in imgs),
            "nodes": sorted(names & set(C.REQUIRED_NODES + C.OPTIONAL_NODES)),
            "glass": C.NODE_GLASS in names, "wired": wired}


def tint_material(hull_id, identity_hex):
    """Reproduce the game's hull shader: basecolor RGB mixed toward the rider's
    identity colour by the accent mask carried in the basecolor ALPHA channel."""
    mat = bpy.data.materials.new("ship_tint")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def tex(path, cs, loc):
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = cs
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = img
        n.location = loc
        return n

    base = tex(C.bake_path(hull_id, C.TEX_BASECOLOR), "sRGB", (-900, 400))
    accent = C.hex_rgb(identity_hex)
    accent = tuple(C.srgb_to_linear(c) for c in accent) + (1.0,)
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.location = (-600, 400)
    mix.inputs[0].default_value = 1.0
    nt.links.new(base.outputs["Color"], mix.inputs[6])
    mix.inputs[7].default_value = accent
    nt.links.new(base.outputs["Alpha"], mix.inputs[0])
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])

    orm = tex(C.bake_path(hull_id, C.TEX_ORM), "Non-Color", (-900, 100))
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-650, 100)
    nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nrm = tex(C.bake_path(hull_id, C.TEX_NORMAL), "Non-Color", (-900, -200))
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-650, -200)
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    emi = tex(C.bake_path(hull_id, C.TEX_EMISSIVE), "sRGB", (-900, -500))
    nt.links.new(emi.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def apply_tint(hull_id, slot):
    identity = C.IDENTITY_HEX[slot % len(C.IDENTITY_HEX)]
    mat = tint_material(hull_id, identity)
    for ob in [o for o in bpy.data.objects if o.type == "MESH"
               and o.name in (C.NODE_HULL, C.NODE_GLASS)]:
        ob.data.materials.clear()
        ob.data.materials.append(mat)
        for p in ob.data.polygons:
            p.material_index = 0
    return identity


def render_proof(hull_id, slot, samples=160, dist_override=None):
    identity = apply_tint(hull_id, slot)
    R.clear_cameras_lights()
    bpy.context.scene.use_nodes = False
    drop_backdrop()
    cen, ext = R.bounds_center(hull_objects())
    cen = tuple(cen)
    R.set_workbench(clay_color=(0.02, 0.025, 0.03), bg=(1.0, 1.0, 1.0), flat=True, cavity=False)
    dist = R.calibrate_dist(cen)
    # silhouette pass first (clean scene, no backdrop/compositor to pollute it)
    R.clear_cameras_lights()
    R.game_camera(cen, dist=dist)
    sil = os.path.join(C.RENDER_DIR, f"{hull_id}_sil.png")
    R.render_wh(sil, w=SIL_W, h=SIL_H)
    if dist_override is not None:
        dist = dist_override

    # then the shaded proof, lit and bloomed like the game
    R.clear_cameras_lights()
    R.game_scene(cen, dist=dist, samples=samples)
    R.boost_emissive(C.EMISSIVE_BOOST_RENDER)
    game = C.render_path(hull_id)
    R.render_wh(game, w=R.GAME_RES_W, h=R.GAME_RES_H)
    R.downscale(game, os.path.join(C.RENDER_DIR, f"{hull_id}_game_960.png"), width=960)
    w, h, frac = R.measure_silhouette(sil)
    stats = R.image_stats(game)
    return {"identity": identity, "silPx": [w, h], "silFrac": round(frac, 3),
            "luma": {k: round(v, 4) for k, v in stats.items()},
            "dist": round(dist, 3), "extent": [round(v, 3) for v in ext]}


def hull_objects():
    return [o for o in bpy.data.objects
            if o.type == "MESH" and o.name in (C.NODE_HULL, C.NODE_GLASS)]


def drop_backdrop():
    for o in [o for o in bpy.data.objects if o.name.startswith("GameBackdrop")]:
        bpy.data.objects.remove(o, do_unlink=True)


def accent_probe(hull_id, slot, res=(480, 270), samples=96):
    """Prove the accent mask + identity tint does something visible: render the
    hull twice, once tinted with the rider's identity colour and once with the
    accent mask neutralised, and measure the changed pixels and their hue."""
    identity = C.IDENTITY_HEX[slot % len(C.IDENTITY_HEX)]
    loads = []
    for tag, tint in (("tint", C.hex_rgb(identity)), ("flat", (0.42, 0.44, 0.47))):
        drop_backdrop()
        mat = tint_material(hull_id, identity)
        mix = next(n for n in mat.node_tree.nodes if n.type == "MIX")
        accent = tuple(C.srgb_to_linear(c) for c in tint) + (1.0,)
        mix.inputs[7].default_value = accent
        objs = hull_objects()
        for ob in objs:
            ob.data.materials.clear()
            ob.data.materials.append(mat)
            for p in ob.data.polygons:
                p.material_index = 0
        cen, _ = R.bounds_center()
        cen = tuple(cen)
        R.clear_cameras_lights()
        bpy.context.scene.use_nodes = False
        R.set_workbench(clay_color=(0.02, 0.025, 0.03), bg=(1.0, 1.0, 1.0), flat=True, cavity=False)
        dist = R.calibrate_dist(cen)
        R.clear_cameras_lights()
        R.game_scene(cen, dist=dist, samples=samples)
        R.boost_emissive(C.EMISSIVE_BOOST_RENDER)
        bpy.context.scene.cycles.use_denoising = True
        p = os.path.join(TMPDIR, f"accent_{hull_id}_{tag}.png")
        R.render_wh(p, w=res[0], h=res[1])
        loads.append(R._load_rgb(p))
    a, b = loads
    diff = np.abs(a - b).max(axis=2)
    changed = diff > 0.03        # clears Cycles sampling noise on the dark hull
    sil = os.path.join(C.RENDER_DIR, f"{hull_id}_sil.png")
    hull_px = None
    if os.path.exists(sil):
        m = R.silhouette_mask(sil)
        h, w = a.shape[:2]
        yi = (np.arange(h) * m.shape[0] / h).astype(int)
        xi = (np.arange(w) * m.shape[1] / w).astype(int)
        hull_px = m[yi][:, xi]
    frac = float(changed.mean())
    of_hull = float(changed[hull_px].mean()) if hull_px is not None else None
    hue = None
    if changed.sum() > 50:
        mean = (a[changed] - b[changed]).mean(axis=0)
        if float(np.abs(mean).max()) > 1e-4:
            import colorsys
            hue = colorsys.rgb_to_hsv(*(float(c) for c in np.abs(mean)))[0] * 360.0
    return {"changedFrac": round(frac, 4),
            "meanDiff": round(float(diff.mean()), 4),
            "accentOfHull": None if of_hull is None else round(of_hull, 4),
            "deltaHue": None if hue is None else round(hue, 1),
            "identityHue": round(hue_of(identity), 1)}


def hue_of(hex_str):
    import colorsys
    r, g, b = C.hex_rgb(hex_str)
    return colorsys.rgb_to_hsv(r, g, b)[0] * 360.0


def sheet():
    """Contact sheet + the fleet-level silhouette metrics."""
    paths, sils = [], []
    for hull in list(C.FLEET) + [C.RAIDER_ID]:
        g = os.path.join(C.RENDER_DIR, f"{hull}_game_960.png")
        if os.path.exists(g):
            paths.append(g)
        s = os.path.join(C.RENDER_DIR, f"{hull}_sil.png")
        if os.path.exists(s):
            sils.append((hull, R.silhouette_mask(s)))
    out = os.path.join(C.RENDER_DIR, "fleet_game.png")
    R.montage(paths, 3, out)
    print(f">>> contact sheet {out}")
    masks = {}
    for hull, m in sils:
        ys, xs = np.where(m)
        if len(xs) == 0:
            continue
        box = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
        m = m[box]
        n = 128
        yi = (np.arange(n) * m.shape[0] / n).astype(int)
        xi = (np.arange(n) * m.shape[1] / n).astype(int)
        masks[hull] = m[yi][:, xi]
        print(f"    {hull:11} silhouette {m.shape[1]}x{m.shape[0]}px "
              f"coverage={float(m.mean()):.3f}")
    if len(masks) >= 2:
        keys = list(masks)
        rows = []
        for i, a in enumerate(keys):
            row = []
            for j, b in enumerate(keys):
                inter = float((masks[a] & masks[b]).sum())
                union = float((masks[a] | masks[b]).sum())
                row.append(inter / union if union else 0.0)
            rows.append(row)
        print("    pairwise silhouette IoU (1.0 = identical outline):")
        print("      " + " ".join(f"{k:>10}"[:10] for k in keys))
        for k, row in zip(keys, rows):
            print(f"      {k:>10} " + " ".join(f"{v:10.3f}" for v in row))
        if C.RAIDER_ID in masks and len(keys) > 1:
            rid = masks[C.RAIDER_ID]
            vs = [(float((rid & masks[k]).sum()) / float((rid | masks[k]).sum()), k)
                  for k in keys if k != C.RAIDER_ID]
            print("    raider vs fleet IoU: " + " ".join(f"{k}={v:.3f}" for v, k in vs)
                  + f"  mean={sum(v for v, _ in vs) / len(vs):.3f}")
        worst = max((v, keys[i], keys[j]) for i, row in enumerate(rows)
                    for j, v in enumerate(row) if i < j)
        print(f"    worst pair: {worst[1]}/{worst[2]} IoU={worst[0]:.3f}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--sheet" in argv:
        sheet()
        return
    hulls = [a for a in argv if not a.startswith("--")] or list(C.BUILD_ORDER)
    report = {}
    for hull_id in hulls:
        slot = C.FLEET.index(hull_id) if hull_id in C.FLEET else 0
        # the raider is its own tile: identity tint is irrelevant to it
        v = validate(hull_id)
        v.update(render_proof(hull_id, slot,
                              dist_override=C.RAIDER_CHASE_DIST if hull_id == C.RAIDER_ID else None))
        v.update(accent_probe(hull_id, slot))
        report[hull_id] = v
        print(f">>> {hull_id}: {v['tris']} tris  {v['bytes'] / 1024:.0f} KB  "
              f"nodes={v['nodes']} glass={v['glass']}  identity={v['identity']}  "
              f"sil={v['silPx']} ({v['silFrac']:.2f} of frame)  luma={v['luma']}  "
              f"accent: {v['accentOfHull']:.1%} of the visible hull, hue "
              f"{v['deltaHue']} vs identity {v['identityHue']}")
    p = os.path.join(C.WORK_DIR, "validate.json")
    with open(p, "w") as fh:
        json.dump(report, fh, indent=2, sort_keys=True)
    print(">>> wrote", p)


if __name__ == "__main__":
    main()
