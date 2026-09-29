"""Headless render helpers for the ship pipeline: cameras, the fixed game-camera
chase rig, workbench silhouettes, identity tinting and numpy montage assembly.

Adapted from the original `assets/ship/render_lib.py`. Cycles runs on CPU for
bakes and renders: Metal GPU bakes silently produce empty (black) images in
`--background` on macOS.
"""
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

GAME_RES_W = 1920
GAME_RES_H = 1080

# game-camera rig, matched to the concept frame: a rear-3/4-high chase that
# shows one flank, the deck and the engine nozzles at once.
YAW = -42.0
PITCH = 20.0
LENS = 52.0
DIST0 = 15.0
TARGET_FRAC = 0.38


def clear_cameras_lights():
    for ob in list(bpy.data.objects):
        if ob.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(ob, do_unlink=True)


def add_camera(loc, target, lens=55.0, name="RigCam"):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = Vector(loc)
    _aim(cam, Vector(target))
    bpy.context.scene.camera = cam
    return cam


def _aim(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_sun(direction, energy=3.0, angle=0.15, name="Key", color=(1.0, 1.0, 1.0)):
    d = bpy.data.lights.new(name, "SUN")
    d.energy = energy
    d.angle = angle
    d.color = color
    ob = bpy.data.objects.new(name, d)
    bpy.context.collection.objects.link(ob)
    v = Vector(direction).normalized()
    ob.rotation_euler = (-v).to_track_quat("Z", "Y").to_euler()
    return ob


def setup_world(color=(0.012, 0.016, 0.024), strength=1.0):
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (*color, 1.0)
        bg.inputs[1].default_value = strength


def setup_env_gradient(top=(0.075, 0.090, 0.120), bottom=(0.012, 0.016, 0.024),
                       strength=1.0):
    """Cool blue-grey sky above, near-black below: the frame background must stay
    the space black the game shows."""
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs[1].default_value = strength
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*bottom, 1.0)
    ramp.color_ramp.elements[1].color = (*top, 1.0)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = -0.5
    mr.inputs["From Max"].default_value = 0.7
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs[0])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def configure_cycles(samples=64, device="CPU"):
    """CPU by default: GPU (Metal) bakes/renders come out empty in
    `--background` on macOS."""
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = device
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    scn.render.bake.margin = 12
    scn.render.bake.use_clear = True
    if hasattr(scn.render.bake, "max_ray_distance"):
        scn.render.bake.max_ray_distance = 0.55


def set_workbench(clay_color=(0.30, 0.32, 0.35), bg=(0.02, 0.025, 0.03),
                  flat=False, cavity=True):
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_WORKBENCH"
    sh = scn.display.shading
    sh.light = "FLAT" if flat else "STUDIO"
    sh.color_type = "SINGLE"
    sh.single_color = clay_color
    sh.show_cavity = cavity
    if cavity:
        sh.cavity_type = "BOTH"
        sh.cavity_ridge_factor = 1.6
        sh.cavity_valley_factor = 1.8
        sh.curvature_ridge_factor = 1.4
        sh.curvature_valley_factor = 1.6
    sh.show_shadows = not flat
    sh.shadow_intensity = 0.55
    sh.background_type = "VIEWPORT"
    sh.background_color = bg
    scn.display.render_aa = "8"


def render_wh(path, w=GAME_RES_W, h=GAME_RES_H, transparent=False):
    scn = bpy.context.scene
    scn.render.resolution_x = w
    scn.render.resolution_y = h
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = transparent
    scn.render.image_settings.file_format = "PNG"
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


# ---------------------------------------------------------------------------
# frame helpers
# ---------------------------------------------------------------------------
def orient_upright(objs=None):
    """Rotate the authored Y-up frame (deck +Y, nose -Z) into Blender's Z-up
    world so the ship STANDS for the render camera: deck -> +Z, nose -> +Y."""
    rot = Matrix.Rotation(math.radians(90), 4, "X")
    if objs is None:
        objs = [o for o in bpy.data.objects
                if o.parent is None and o.type in {"MESH", "EMPTY"}]
    for ob in objs:
        ob.matrix_world = rot @ ob.matrix_world


def world_bounds(objs=None):
    """Fresh world-space (lo, hi) over mesh vertices. `bound_box` is a cache
    that goes stale after a raw mesh transform, so never use it here."""
    lo = Vector((1e9,) * 3)
    hi = -lo
    for o in (objs if objs is not None else bpy.data.objects):
        if o.type != "MESH":
            continue
        m = o.matrix_world
        for v in o.data.vertices:
            w = m @ v.co
            lo = Vector((min(lo[i], w[i]) for i in range(3)))
            hi = Vector((max(hi[i], w[i]) for i in range(3)))
    return lo, hi


def bounds_center(objs=None):
    lo, hi = world_bounds(objs)
    return (lo + hi) * 0.5, (hi - lo)


def game_camera(center, yaw=YAW, pitch=PITCH, dist=DIST0, lens=LENS):
    """Blender Z-up rear-3/4-high chase (call orient_upright() first). yaw=0 is
    directly behind the tail (-Y) looking toward the nose (+Y); negative yaw
    swings the camera to port so the nose reads to screen-RIGHT."""
    yr, pr = math.radians(yaw), math.radians(pitch)
    x = center[0] + dist * math.cos(pr) * math.sin(yr)
    y = center[1] - dist * math.cos(pr) * math.cos(yr)
    z = center[2] + dist * math.sin(pr)
    return add_camera((x, y, z), center, lens=lens, name="GameCam")


def game_lights(energy=7.2):
    """Six-sun studio rig: a key from the camera's upper-left plus five softer
    lights around the hull, so the whole silhouette carries readable value
    instead of one lit flank and a black rest. The world stays dark."""
    setup_env_gradient()
    add_sun((0.50, 0.50, -0.70), energy=energy * 1.15, angle=0.25, name="Key",
            color=(1.0, 0.95, 0.88))
    add_sun((-0.60, 0.45, -0.55), energy=energy * 1.7, angle=0.4, name="Key2",
            color=(0.90, 0.94, 1.0))
    add_sun((-0.35, -0.62, -0.15), energy=energy * 1.6, angle=0.4, name="Rim",
            color=(0.44, 0.70, 1.0))
    add_sun((0.70, -0.35, 0.20), energy=energy * 1.55, angle=0.6, name="Side",
            color=(0.80, 0.86, 1.0))
    add_sun((-0.20, 0.25, 0.95), energy=energy * 1.55, angle=0.8, name="Fill",
            color=(0.72, 0.78, 0.95))
    add_sun((0.30, -0.80, 0.35), energy=energy * 1.4, angle=0.8, name="Aft",
            color=(0.85, 0.88, 1.0))


def game_bloom(threshold=0.80, size=0.40, strength=1.0):
    """Compositor fog-glow so the emissive practicals bloom like the game's HDR
    pass (the bake is LDR, so the readable glow comes from here)."""
    scn = bpy.context.scene
    scn.use_nodes = True
    ng = bpy.data.node_groups.get("game_comp") or \
        bpy.data.node_groups.new("game_comp", "CompositorNodeTree")
    ng.nodes.clear()
    scn.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    gl = ng.nodes.new("CompositorNodeGlare")
    for name, val in (("Type", "Fog Glow"), ("Quality", "High"),
                      ("Highlights Threshold", threshold), ("Size", size),
                      ("Strength", strength)):
        if name in gl.inputs:
            try:
                gl.inputs[name].default_value = val
            except Exception:
                pass
    if not any(s.in_out == "OUTPUT" for s in ng.interface.items_tree):
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
    ng.links.new(gl.outputs["Image"], out.inputs["Image"])


def boost_emissive(strength=1.6):
    """Drive Emission Strength above 1 for the RENDER only (the shipped GLB
    keeps 1.0). Capped so the engine rims glow instead of clipping to white."""
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for nd in mat.node_tree.nodes:
            if nd.type == "BSDF_PRINCIPLED":
                nd.inputs["Emission Strength"].default_value = strength


def game_scene(center, yaw=YAW, pitch=PITCH, dist=DIST0, lens=LENS, samples=96,
               bloom=True):
    configure_cycles(samples=samples, device="CPU")
    scn = bpy.context.scene
    scn.view_settings.view_transform = "AgX"
    scn.view_settings.exposure = 0.55
    cam = game_camera(center, yaw=yaw, pitch=pitch, dist=dist, lens=lens)
    game_lights()
    if bloom:
        try:
            game_bloom()
        except Exception as e:
            print(">>> bloom skipped:", e)
    return cam


def calibrate_dist(center, target_frac=TARGET_FRAC, lo=9.0, hi=26.0, lens=LENS):
    """Place the game camera so the hull silhouette occupies ~target_frac of the
    frame width: the composition the concept frame uses."""
    clear_cameras_lights()
    set_workbench(clay_color=(0.02, 0.025, 0.03), bg=(1.0, 1.0, 1.0), flat=True, cavity=False)
    game_camera(center, dist=DIST0, lens=lens)
    tmp = os.path.join(os.path.dirname(bpy.data.filepath) or "/tmp", "_calib.png")
    render_wh(tmp, w=640, h=360)
    _, _, frac = measure_silhouette(tmp)
    dist = DIST0 * (frac / target_frac) if frac > 0 else DIST0
    return max(lo, min(hi, dist))


# ---------------------------------------------------------------------------
# numpy image helpers
# ---------------------------------------------------------------------------
def _load_rgb(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)[::-1]  # flip to top-left origin
    bpy.data.images.remove(img)
    return a[:, :, :3]


def save_rgb(arr, path):
    """arr: HxWx3 float 0..1, top-left origin -> PNG."""
    h, w, _ = arr.shape
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(arr, 0.0, 1.0)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels.foreach_set(rgba[::-1].reshape(-1))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def _resize_area(a, tw, th):
    """Area-average resample (faithful downscale, not nearest)."""
    h, w, c = a.shape
    ys = np.linspace(0, h, th + 1).astype(int)
    xs = np.linspace(0, w, tw + 1).astype(int)
    out = np.empty((th, tw, c), np.float32)
    for j in range(th):
        row = a[ys[j]:max(ys[j] + 1, ys[j + 1])]
        for i in range(tw):
            out[j, i] = row[:, xs[i]:max(xs[i] + 1, xs[i + 1])].mean(axis=(0, 1))
    return out


def downscale(src, out, width=250):
    a = _load_rgb(src)
    h, w, _ = a.shape
    save_rgb(_resize_area(a, width, max(1, round(width * h / w))), out)
    return out


def montage(paths, cols, out, pad=8, bg=0.02, labels=None):
    """Grid of PNGs (all the same size) -> one sheet."""
    imgs = [_load_rgb(p) for p in paths]
    th, tw, _ = imgs[0].shape
    rows = (len(imgs) + cols - 1) // cols
    canvas = np.full((rows * th + pad * (rows + 1), cols * tw + pad * (cols + 1), 3), bg, np.float32)
    for i, im in enumerate(imgs):
        r, c = divmod(i, cols)
        y = pad + r * (th + pad)
        x = pad + c * (tw + pad)
        canvas[y:y + th, x:x + tw] = im
    save_rgb(canvas, out)
    return out


def measure_silhouette(path, dark_ship=True):
    """Ship pixel bbox in a silhouette render -> (w_px, h_px, frac_w)."""
    a = _load_rgb(path)
    h, w, _ = a.shape
    lum = a.mean(axis=2)
    mask = lum < 0.5 if dark_ship else lum > 0.5
    cols = np.where(mask.any(axis=0))[0]
    rows = np.where(mask.any(axis=1))[0]
    if len(cols) == 0 or len(rows) == 0:
        return (0, 0, 0.0)
    return (int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1),
            (cols[-1] - cols[0] + 1) / w)


def silhouette_mask(path, dark_ship=True, thresh=0.5):
    a = _load_rgb(path)
    lum = a.mean(axis=2)
    return (lum < thresh) if dark_ship else (lum > thresh)


def image_stats(path):
    a = _load_rgb(path)
    lum = a.mean(axis=2)
    return {"mean": float(lum.mean()), "p05": float(np.percentile(lum, 5)),
            "p95": float(np.percentile(lum, 95)), "std": float(lum.std())}
