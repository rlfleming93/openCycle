"""Stage 1: bring one vendor hull into the fleet frame.

    source            -> work/<hull>.imported.blend

Source lookup is the first match of `**/<Name>*.gltf|*.glb`, else `*.blend`
(objects appended), else `*.fbx`. The vendor mesh is authored in Blender's
normal frame (deck +Z, nose -Y, wings +-X); the fleet frame is the three.js
frame used everywhere else in this pipeline (deck +Y, nose -Z, wings +-X) and is
written raw into the GLB with `export_yup=False`.

Anything the vendor ships as an exhaust/flame mesh is deleted: openCycle draws
its own plumes on the nozzle nodes.

Run: blender --background --factory-startup --python assets/ships/import_base.py -- striker challenger
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import fleet_config as C  # noqa: E402
import render_lib as R  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

FLAME_RE = re.compile(r"flame|exhaust|jet|plume|thruster_glow|engine_glow", re.I)

# vendor frame -> fleet frame: swap Y and Z so the deck turns from +Z to +Y and
# the nose from -Y to -Z. The swap is orientation-reversing, so the mesh normals
# are flipped right after it.
FLEET_SWAP = Matrix(((1.0, 0.0, 0.0, 0.0),
                     (0.0, 0.0, 1.0, 0.0),
                     (0.0, 1.0, 0.0, 0.0),
                     (0.0, 0.0, 0.0, 1.0)))


def wipe():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(path):
    """Import by extension and return the mesh objects it produced."""
    ext = os.path.splitext(path)[1].lower()
    if ext in {".gltf", ".glb"}:
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        try:
            bpy.ops.preferences.addon_enable(module="io_scene_fbx")
        except Exception:
            pass
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = [n for n in src.objects]
    else:
        raise ValueError(f"unsupported source format: {path}")
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def flatten_transforms():
    """Drop parenting and bake every object transform into its mesh so the rest
    of the pipeline only ever deals with world-space vertex data."""
    for ob in list(bpy.context.scene.objects):
        if ob.type == "EMPTY":
            bpy.data.objects.remove(ob, do_unlink=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no mesh objects imported")
    bpy.ops.object.select_all(action="DESELECT")
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return meshes


def strip_flames(meshes):
    """Delete vendor exhaust/flame geometry (objects or per-face material slots)."""
    removed = []
    for ob in list(meshes):
        if FLAME_RE.search(ob.name):
            removed.append(ob.name)
            meshes.remove(ob)
            bpy.data.objects.remove(ob, do_unlink=True)
            continue
        flame_slots = [i for i, m in enumerate(ob.data.materials)
                       if m and FLAME_RE.search(m.name)]
        if not flame_slots:
            continue
        keep = [p.index for p in ob.data.polygons if p.material_index not in flame_slots]
        removed.append(f"{ob.name}:{len(ob.data.polygons) - len(keep)} faces")
        if not keep:
            meshes.remove(ob)
            bpy.data.objects.remove(ob, do_unlink=True)
            continue
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.object.mode_set(mode="OBJECT")
        for i in keep:
            ob.data.polygons[i].select = True
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="FACE")
        bpy.ops.mesh.delete(type="FACE")
        bpy.ops.object.mode_set(mode="OBJECT")
    return removed


def join_hull(meshes, name):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    hull = bpy.context.view_layer.objects.active
    hull.name = name
    hull.data.name = name
    return hull


def to_fleet_frame(hull, target_len):
    """Vendor frame -> fleet frame, then uniform scale to `target_len` and
    recentre so the hull's bounding-box centre sits on the origin: the three.js
    formation slots and the chase camera both assume that origin."""
    lo, hi = R.world_bounds([hull])
    ext = hi - lo
    if ext.y <= 0:
        raise RuntimeError("degenerate hull bounds")
    scale = target_len / ext.y
    hull.data.transform(Matrix.Diagonal((scale, scale, scale, 1.0)))
    hull.data.transform(FLEET_SWAP)
    hull.data.flip_normals()
    lo, hi = R.world_bounds([hull])
    hull.data.transform(Matrix.Translation(-(lo + hi) * 0.5))
    return scale


def compute_metrics(hull):
    """The numbers the silhouette criteria are checked against."""
    lo, hi = R.world_bounds([hull])
    ext = hi - lo
    hull.data.calc_loop_triangles()
    return {
        "spanX": round(ext.x, 3),
        "upY": round(ext.y, 3),
        "lengthZ": round(ext.z, 3),
        "lengthSpanRatio": round(ext.z / ext.x, 3),
        "tris": len(hull.data.loop_triangles),
        "verts": len(hull.data.vertices),
    }


def build(hull_id):
    wipe()
    path = C.source_path(hull_id)
    if path is None:
        raise FileNotFoundError(f"no vendor source for {hull_id} in {C.source_dir(hull_id)}")
    src_fmt = os.path.splitext(path)[1].lower().lstrip(".")
    import_source(path)
    meshes = flatten_transforms()
    stripped = strip_flames(meshes)
    hull = join_hull(meshes, C.NODE_HULL)
    scale = to_fleet_frame(hull, C.TARGET_LENGTH)
    metrics = compute_metrics(hull)
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=C.work_blend_stage(hull_id, "imported"))
    meta = {"hull": hull_id, "source": os.path.relpath(path, C.REPO), "sourceFormat": src_fmt,
            "stripped": stripped, "scale": round(scale, 4),
            "sourceMaterials": [m.name for m in hull.data.materials if m],
            **metrics}
    with open(os.path.join(C.WORK_DIR, f"{hull_id}.import.json"), "w") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True)
    return meta


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for hull_id in (argv or C.FLEET):
        meta = build(hull_id)
        print(f">>> {hull_id}: {meta['tris']} tris  span={meta['spanX']} "
              f"up={meta['upY']} length={meta['lengthZ']} L/S={meta['lengthSpanRatio']} "
              f"(from {meta['source']})")


if __name__ == "__main__":
    main()
