"""Stage 3: flatten the finish into one atlas and export the GLB.

    work/<hull>.finished.blend -> work/<hull>.blend + apps/web/public/assets/ships/<hull>.glb

One 2048 atlas per hull, four maps:

    basecolor  sRGB   RGB = livery, ALPHA = accent mask (identity tint source)
    normal     linear greebles + panel lines
    orm        linear R = AO, G = roughness (0.35-0.7), B = metallic
    emissive   sRGB   engine rims only

Cycles runs on CPU: Metal GPU bakes come out empty (black) in `--background`.
Every bake goes through the emit-swap trick from the original ship pipeline,
and colour maps are composed in numpy and written with a fresh image datablock
because `Image.save()` on a freshly baked image serialises black.

Run: blender --background --factory-startup --python assets/ships/bake_export.py -- striker
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import fleet_config as C  # noqa: E402
import numpy as np  # noqa: E402

AO_SAMPLES = 128
RESIN = "srcUV"
ATLAS = "UVMap"


# ---------------------------------------------------------------------------
# bake plumbing
# ---------------------------------------------------------------------------
def configure_bake(samples, denoise=False):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = denoise
    scn.render.bake.margin = 12
    scn.render.bake.use_clear = True
    if hasattr(scn.render.bake, "max_ray_distance"):
        scn.render.bake.max_ray_distance = 0.55


def new_img(name, colorspace):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, C.TEX, C.TEX, alpha=False, float_buffer=True)
    img.colorspace_settings.name = colorspace
    return img


def save_np(rgba_flat, path, colorspace):
    """The ONLY reliable save path: image.save() on a freshly baked image
    serialises black (the baked ImBuf is not what save() writes)."""
    out = bpy.data.images.new("_save", C.TEX, C.TEX, alpha=True, float_buffer=False)
    out.colorspace_settings.name = colorspace
    out.pixels.foreach_set(np.ascontiguousarray(rgba_flat, dtype=np.float32))
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


def save_baked(img, path, colorspace):
    a = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(a)
    save_np(a, path, colorspace)
    return a.reshape(C.TEX, C.TEX, 4)


def img_to_np(img):
    a = np.empty(C.TEX * C.TEX * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(C.TEX, C.TEX, 4)


def box_blur(a, passes=1):
    """Cheap separable 5-tap blur. Used to flatten the colour field and to take
    the Cycles sampling noise out of the AO map: the maps ship as lossless PNG,
    and per-texel noise is what makes them huge."""
    out = a
    for _ in range(passes):
        out = (out + np.roll(out, 1, axis=0) + np.roll(out, -1, axis=0)
               + np.roll(out, 1, axis=1) + np.roll(out, -1, axis=1)) / 5.0
    return out


def quantize(a, step):
    return np.round(a / step) * step


def low_pass(a, n):
    """Area-average down to n x n, then box-interpolate back up: a true low-pass
    that keeps the colour field and drops the resampling detail."""
    h, w, c = a.shape
    f = max(1, h // n)
    small = a.reshape(n, f, n, f, c).mean(axis=(1, 3))
    up = np.repeat(np.repeat(small, f, axis=0), f, axis=1)[:h, :w]
    return box_blur(up, passes=1)


def inpaint(a, covered, passes=48):
    """Dilate covered texels outward over the atlas gaps. The bake clears the
    target image, so UV islands leave gaps that are pure black; with mipmaps or
    bilinear filtering those gaps bleed onto the surface as black blotches."""
    out = a.copy()
    have = covered.copy()
    for _ in range(passes):
        if have.all():
            break
        filled = np.zeros_like(have)
        acc = np.zeros_like(out)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh_h = np.roll(have, (dy, dx), axis=(0, 1))
            sh_a = np.roll(out, (dy, dx), axis=(0, 1))
            take = sh_h & ~have & ~filled
            acc[take] = sh_a[take]
            filled |= take
        out[filled] = acc[filled]
        have |= filled
    return out


def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def output_node(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL")


def add_bake_node(mat):
    n = mat.node_tree.nodes.new("ShaderNodeTexImage")
    n.name = "_bake"
    n.location = (400, 600)
    return n


def set_target(mats, image):
    for m in mats:
        nt = m.node_tree
        n = nt.nodes["_bake"]
        n.image = image
        for other in nt.nodes:
            other.select = False
        n.select = True
        nt.nodes.active = n


_saved = {}


def swap_to_emit(mat, value_or_socket):
    nt = mat.node_tree
    out = output_node(mat)
    _saved[mat.name] = out.inputs["Surface"].links[0].from_socket
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.name = "_bake_emit"
    if isinstance(value_or_socket, (int, float)):
        emit.inputs["Color"].default_value = (float(value_or_socket),) * 3 + (1.0,)
    elif isinstance(value_or_socket, (tuple, list)):
        emit.inputs["Color"].default_value = tuple(value_or_socket[:3]) + (1.0,)
    else:
        nt.links.new(value_or_socket, emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])


def restore_output(mat):
    nt = mat.node_tree
    out = output_node(mat)
    nt.links.new(_saved[mat.name], out.inputs["Surface"])
    e = nt.nodes.get("_bake_emit")
    if e:
        nt.nodes.remove(e)


def bake(objs, mats, image, btype, samples, denoise=False):
    configure_bake(samples, denoise)
    set_target(mats, image)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=btype)
    print(f"    baked {btype} -> {image.name}")


# ---------------------------------------------------------------------------
# UV
# ---------------------------------------------------------------------------
def prepare_uv(hull):
    """The vendor UVs drive the source-albedo lookup, so they survive as the
    `srcUV` layer while the atlas is unwrapped into a fresh active layer."""
    me = hull.data
    if RESIN in me.uv_layers:
        me.uv_layers.remove(me.uv_layers[RESIN])
    for lyr in me.uv_layers:
        lyr.name = RESIN
        break
    atlas = me.uv_layers.new(name=ATLAS)
    me.uv_layers.active = atlas
    atlas.active_render = True
    bpy.ops.object.select_all(action="DESELECT")
    hull.select_set(True)
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.004,
                             area_weight=0.0, correct_aspect=True)
    bpy.ops.uv.pack_islands(margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")


def strip_source_uv(hull):
    """The shipped GLB carries one UV set."""
    me = hull.data
    if RESIN in me.uv_layers and len(me.uv_layers) > 1:
        me.uv_layers.remove(me.uv_layers[RESIN])


# ---------------------------------------------------------------------------
# final material
# ---------------------------------------------------------------------------
def gltf_settings_group():
    name = "glTF Settings"
    g = bpy.data.node_groups.get(name)
    if g:
        return g
    g = bpy.data.node_groups.new(name, "ShaderNodeTree")
    g.interface.new_socket("Occlusion", socket_type="NodeSocketFloat")
    g.nodes.new("NodeGroupOutput")
    g.nodes.new("NodeGroupInput")
    return g


def final_material(hull_id):
    mat = bpy.data.materials.new("ship")
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

    base = tex(C.bake_path(hull_id, C.TEX_BASECOLOR), "sRGB", (-700, 400))
    nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    orm = tex(C.bake_path(hull_id, C.TEX_ORM), "Non-Color", (-700, 100))
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-450, 100)
    nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nrm = tex(C.bake_path(hull_id, C.TEX_NORMAL), "Non-Color", (-700, -200))
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (-450, -200)
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    emi = tex(C.bake_path(hull_id, C.TEX_EMISSIVE), "sRGB", (-700, -500))
    nt.links.new(emi.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0

    grp = nt.nodes.new("ShaderNodeGroup")
    grp.node_tree = gltf_settings_group()
    grp.location = (-200, 300)
    nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
    return mat


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def build(hull_id):
    path = C.work_blend_stage(hull_id, "finished")
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    bpy.ops.wm.open_mainfile(filepath=path)
    hull = bpy.data.objects[C.NODE_HULL]
    glass = bpy.data.objects.get(C.NODE_GLASS)

    hmat = bpy.data.materials["hull_design"]
    emat = bpy.data.materials["engine_design"]
    dmat = bpy.data.materials["engine_dark_design"]
    for m in (hmat, emat, dmat):
        add_bake_node(m)

    prepare_uv(hull)
    if glass is not None:
        prepare_uv(glass)
        bpy.ops.object.select_all(action="DESELECT")
        glass.select_set(True)
        hull.select_set(True)
        bpy.context.view_layer.objects.active = hull
        bpy.ops.object.join()
        hull = bpy.context.view_layer.objects.active
        glass = None
    objs = [hull]
    mats = [hmat, emat, dmat]

    img = {k: new_img(k, cs) for k, cs in (
        ("bc", "sRGB"), ("mask", "Non-Color"), ("mt", "Non-Color"),
        ("ao", "Non-Color"), ("nm", "Non-Color"), ("em", "sRGB"), ("cov", "Non-Color"))}

    # basecolor: the design livery, baked through emit (DIFFUSE comes back black
    # on metals), then the accent mask on its own so it can land in alpha.
    base_sock = principled(hmat).inputs["Base Color"].links[0].from_socket
    swap_to_emit(hmat, base_sock)
    swap_to_emit(emat, tuple(principled(emat).inputs["Base Color"].default_value))
    bake(objs, mats, img["bc"], "EMIT", 1)
    restore_output(hmat)
    restore_output(emat)

    mask_sock = hmat.node_tree.nodes["mask"].outputs[0]   # Math node -> "Value"
    node = hmat.node_tree.nodes["satMask"]
    base_cut = node.inputs["From Min"].default_value
    mask_cov = 0.0
    chosen = base_cut
    best = None
    for step in range(13):
        cut = base_cut + 0.01 * step
        node.inputs["From Min"].default_value = cut
        node.inputs["From Max"].default_value = cut + 0.07
        swap_to_emit(hmat, mask_sock)
        swap_to_emit(emat, 0.0)
        bake(objs, mats, img["mask"], "EMIT", 1)
        restore_output(hmat)
        restore_output(emat)
        mask_cov = float((img_to_np(img["mask"])[:, :, 0] > 0.5).mean())
        if best is None or abs(mask_cov - C.ACCENT_ATLAS_TARGET) < abs(best[1] - C.ACCENT_ATLAS_TARGET):
            best = (cut, mask_cov)
            chosen = cut
        if C.ACCENT_ATLAS_MIN <= mask_cov <= C.ACCENT_ATLAS_MAX:
            break
    # the vendor paint sits on a saturation cliff: a step too far erases the mask
    # entirely, so re-bake the cut whose coverage landed closest to the target
    if abs(chosen - base_cut) > 1e-9:
        node.inputs["From Min"].default_value = chosen
        node.inputs["From Max"].default_value = chosen + 0.07
        swap_to_emit(hmat, mask_sock)
        swap_to_emit(emat, 0.0)
        bake(objs, mats, img["mask"], "EMIT", 1)
        restore_output(hmat)
        restore_output(emat)
        mask_cov = float((img_to_np(img["mask"])[:, :, 0] > 0.5).mean())
    print(f"    accent covers {mask_cov:.3f} of the atlas at saturation cut {chosen:.3f}")

    # metallic has no native bake type: route the socket through emission
    metal_sock = principled(hmat).inputs["Metallic"].links[0].from_socket
    swap_to_emit(hmat, metal_sock)
    swap_to_emit(emat, 0.95)
    bake(objs, mats, img["mt"], "EMIT", 1)
    restore_output(hmat)
    restore_output(emat)

    # the real emission (engine rims only), then the data passes
    bake(objs, mats, img["em"], "EMIT", 1)
    bake(objs, mats, img["nm"], "NORMAL", 1)
    bake(objs, mats, img["ao"], "AO", AO_SAMPLES, denoise=True)

    # coverage: white everywhere geometry lands, black in the atlas gaps
    swap_to_emit(hmat, 1.0)
    swap_to_emit(emat, 1.0)
    bake(objs, mats, img["cov"], "EMIT", 1)
    restore_output(hmat)
    restore_output(emat)
    covered = img_to_np(img["cov"])[:, :, 0] > 0.5
    print(f"    atlas coverage {float(covered.mean()):.3f}")

    bc = save_baked(img["bc"], C.bake_path(hull_id, C.TEX_BASECOLOR), "sRGB")
    em = save_baked(img["em"], C.bake_path(hull_id, C.TEX_EMISSIVE), "sRGB")
    nm = save_baked(img["nm"], C.bake_path(hull_id, C.TEX_NORMAL), "Non-Color")
    mask = img_to_np(img["mask"])[:, :, 0]
    ao = img_to_np(img["ao"])[:, :, 0]
    mt = img_to_np(img["mt"])[:, :, 0]

    # Atlas gaps are black; dilate the baked texels into them so filtering never
    # samples the gap (that is what produced black blotches along island edges).
    flat_nm = nm[:, :, :3]
    for arr in (bc, flat_nm, em):
        arr[:, :] = inpaint(arr, covered)
    ao = inpaint(ao[:, :, None], covered)[:, :, 0]
    mt = inpaint(mt[:, :, None], covered)[:, :, 0]
    mask = inpaint(mask[:, :, None], covered)[:, :, 0]
    # the normal map's third channel is a constant on an inpainted flat, and the
    # gaps must not carry a bogus tangent frame either
    flat_nm[:, :, 2] = np.where(covered, nm[:, :, 2], 1.0)

    # The base colour is a flat paint field with the accent mask on its alpha:
    # all the surface detail lives in the normal and ORM maps, so the colour is
    # low-passed hard (which is also what the concept frame's single flat hull
    # material looks like) while the mask keeps its edge.
    bc[:, :, :3] = quantize(low_pass(bc[:, :, :3], C.BASECOLOR_FIELD), 2 / 255)
    mask = quantize(mask, 1 / 8)
    bc[:, :, 3] = np.clip(mask, 0.0, 1.0)
    save_np(bc.reshape(-1), C.bake_path(hull_id, C.TEX_BASECOLOR), "sRGB")

    # ORM: R=AO (crevices only, floored), G=roughness, B=metal
    ao = np.clip(quantize(box_blur(ao, passes=2), 1 / 12), C.AO_FLOOR, 1.0)
    # the plan's roughness band has to span the AO range that survives the floor
    opts = C.finish_opts(hull_id)
    wear = np.clip((ao - C.AO_FLOOR) / max(1e-6, 1.0 - C.AO_FLOOR), 0.0, 1.0)
    rough = opts["roughHi"] - (opts["roughHi"] - opts["roughLo"]) * wear
    rough = np.where(em[:, :, :3].max(axis=2) > 0.02, 0.22, rough)
    rough = np.where(mask > 0.5, np.maximum(rough, 0.45), rough)
    rough = quantize(rough, 1 / 16)
    orm = np.stack([np.clip(ao, 0, 1), np.clip(rough, 0, 1), np.clip(mt, 0, 1),
                    np.ones_like(ao)], axis=-1)
    save_np(orm.reshape(-1), C.bake_path(hull_id, C.TEX_ORM), "Non-Color")

    # the engine rim glows, capped below clipping so bloom does the work
    em = np.clip(em, 0.0, C.EMISSIVE_MAX)
    save_np(em.reshape(-1), C.bake_path(hull_id, C.TEX_EMISSIVE), "sRGB")

    for kind in (C.TEX_BASECOLOR, C.TEX_ORM, C.TEX_NORMAL, C.TEX_EMISSIVE):
        p = C.bake_path(hull_id, kind)
        chk = bpy.data.images.load(p, check_existing=False)
        a = np.empty(len(chk.pixels), dtype=np.float32)
        chk.pixels.foreach_get(a)
        a = a.reshape(-1, 4)
        print(f"    DISK {os.path.basename(p)} rgb_max={a[:, :3].max():.3f} "
              f"rgb_mean={a[:, :3].mean():.3f} a_mean={a[:, 3].mean():.3f}")
        bpy.data.images.remove(chk)

    fmat = final_material(hull_id)
    hull.data.materials.clear()
    hull.data.materials.append(fmat)
    for p in hull.data.polygons:
        p.material_index = 0
    for m in (hmat, emat):
        if m.users == 0:
            bpy.data.materials.remove(m)
    strip_source_uv(hull)

    hull.data.calc_loop_triangles()
    bpy.ops.wm.save_as_mainfile(filepath=C.work_blend(hull_id))

    bpy.ops.export_scene.gltf(
        filepath=C.glb_path(hull_id),
        export_format="GLB",
        export_yup=False,
        export_image_format="AUTO",
        export_draco_mesh_compression_enable=False,
        export_apply=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        use_selection=False,
        use_visible=False,
    )
    size = os.path.getsize(C.glb_path(hull_id))
    print(f">>> exported {C.glb_path(hull_id)} ({size / 1024:.0f} KB, "
          f"{len(hull.data.loop_triangles)} tris)")
    return {"glb": os.path.relpath(C.glb_path(hull_id), C.REPO),
            "bytes": size, "tris": len(hull.data.loop_triangles)}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for hull_id in (argv or C.BUILD_ORDER):
        r = build(hull_id)
        print(f">>> {hull_id}: {r['bytes'] / 1024:.0f} KB {r['tris']} tris")


if __name__ == "__main__":
    main()
