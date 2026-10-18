"""Build low-poly plant assets for the eco map: a large tree, a medium tree and a small grass tuft.

Units are real metres, Z up, and every plant has its origin at the centre of its base, so the
web map can place it at a GPS point and scale it by 1 / metersPerUnit.

Run it in a separate background Blender so that no open file is touched:

    blender -b --factory-startup --python tools/blender/make_lowpoly_plants.py

It builds a fresh file with the "Plants_LowPoly" scene, renders preview images, exports one
GLB per plant to public/models/plants/ and saves assets/blender/plants_lowpoly.blend.
(Do not run it inside a GUI session that has another scene open: exporting a scene that is
not shown in the window crashed Blender 5.2.2 in depsgraph evaluation.)
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = r"D:\Users\G433m\Documents\biomemap"
GLB_DIR = os.path.join(ROOT, "public", "models", "plants")
ASSET_DIR = os.path.join(ROOT, "assets", "blender")
SCENE_NAME = "Plants_LowPoly"

rng = random.Random(20261018)


# ---------------------------------------------------------------- materials

def srgb(hex_color):
    """'#RRGGBB' -> linear RGBA, which is what Blender colour sockets expect."""
    out = []
    for i in (1, 3, 5):
        c = int(hex_color[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


def material(name, hex_color, roughness=0.85):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = srgb(hex_color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    m.diffuse_color = srgb(hex_color)
    m.use_backface_culling = False
    return m


MAT = {
    "bark": material("PL_Bark", "#6B4A32", 0.95),
    "leaf_a": material("PL_Leaf_A", "#5E9E3F"),
    "leaf_b": material("PL_Leaf_B", "#4A8636"),
    "leaf_c": material("PL_Leaf_Light", "#7DB24A"),
    "conifer_a": material("PL_Conifer_A", "#2F6E45"),
    "conifer_b": material("PL_Conifer_B", "#3C7F4F"),
    "grass_a": material("PL_Grass_A", "#6FAE3E"),
    "grass_b": material("PL_Grass_B", "#8CC152"),
}


# ---------------------------------------------------------------- mesh helpers

class Builder:
    """Collects geometry for one object with per-face material slots."""

    def __init__(self, slots):
        self.bm = bmesh.new()
        self.slots = slots

    def face(self, verts, slot):
        f = self.bm.faces.new(verts)
        f.material_index = self.slots.index(slot)
        f.smooth = False
        return f

    def ring(self, center, radius, sides, rot=0.0, jitter=0.0, axis=None):
        q = (axis or Vector((0, 0, 1))).to_track_quat("Z", "Y")
        out = []
        for i in range(sides):
            a = rot + 2 * math.pi * i / sides
            r = radius * (1 + rng.uniform(-jitter, jitter))
            out.append(self.bm.verts.new(center + q @ Vector((math.cos(a) * r, math.sin(a) * r, 0))))
        return out

    def bridge(self, lower, upper, slot):
        n = len(lower)
        for i in range(n):
            j = (i + 1) % n
            self.face((lower[i], lower[j], upper[j], upper[i]), slot)

    def tube(self, points, radii, sides, slot, cap_bottom=True, cap_top=True):
        """Tapered prism through a list of centre points (trunks and branches)."""
        rings = []
        rot = rng.uniform(0, math.pi)
        for k, (p, r) in enumerate(zip(points, radii)):
            nxt = points[min(k + 1, len(points) - 1)]
            prv = points[max(k - 1, 0)]
            axis = (nxt - prv).normalized()
            rings.append(self.ring(p, r, sides, rot, 0.06, axis))
        for a, b in zip(rings, rings[1:]):
            self.bridge(a, b, slot)
        if cap_bottom:
            self.face(list(reversed(rings[0])), slot)
        if cap_top:
            self.face(rings[-1], slot)

    def blob(self, center, radius, slot, squash=0.82, wobble=0.13):
        """Faceted canopy lump: a jittered icosphere."""
        res = bmesh.ops.create_icosphere(
            self.bm, subdivisions=2, radius=radius,
            matrix=Matrix.Translation(center) @ Matrix.Diagonal((1, 1, squash, 1)))
        verts = res["verts"]
        for v in verts:
            d = (v.co - center)
            v.co += d.normalized() * radius * rng.uniform(-wobble, wobble)
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = self.slots.index(slot)
            f.smooth = False

    def cone(self, z0, radius, height, slot, sides=8):
        """One tier of an evergreen: drooping base ring, offset mid ring, apex, hollow underside."""
        rot = rng.uniform(0, math.pi)
        base = self.ring(Vector((0, 0, z0)), radius, sides, rot, 0.08)
        for v in base:
            v.co.z += rng.uniform(-0.06, 0.06)
        mid = self.ring(Vector((0, 0, z0 + height * 0.48)), radius * 0.56, sides, rot + math.pi / sides, 0.07)
        apex = self.bm.verts.new((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), z0 + height))
        under = self.bm.verts.new((0, 0, z0 + height * 0.18))
        n = sides
        for i in range(n):
            j = (i + 1) % n
            self.face((base[i], base[j], mid[i]), slot)
            self.face((mid[i], base[j], mid[j]), slot)
            self.face((mid[i], mid[j], apex), slot)
            self.face((base[j], base[i], under), slot)

    def to_object(self, name, collection, props):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for slot in self.slots:
            me.materials.append(MAT[slot])
        obj = bpy.data.objects.new(name, me)
        for k, v in props.items():
            obj[k] = v
        collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------- plants

def make_large_tree(col):
    """Broadleaf shade tree in the style of a zelkova, about 11 m tall."""
    b = Builder(["bark", "leaf_a", "leaf_b", "leaf_c"])
    lean = Vector((0.18, 0.06, 0))
    trunk = [Vector((0, 0, 0)), Vector((0, 0, 0.4)), Vector((0, 0, 2.6)) + lean * 0.5, Vector((0, 0, 4.6)) + lean]
    b.tube(trunk, [0.62, 0.43, 0.33, 0.24], 7, "bark")
    for yaw, z in ((20, 3.5), (140, 3.9), (260, 3.7)):
        a = math.radians(yaw + rng.uniform(-12, 12))
        start = Vector((0, 0, z)) + lean * (z / 4.6)
        end = start + Vector((math.cos(a) * 1.9, math.sin(a) * 1.9, 2.3))
        b.tube([start, (start + end) / 2 + Vector((0, 0, 0.2)), end], [0.17, 0.12, 0.07], 5, "bark", cap_bottom=False)
    canopy = [
        ((0.1, 0.0, 7.0), 3.0, "leaf_a"),
        ((2.1, 0.8, 6.3), 2.2, "leaf_b"),
        ((-1.9, 1.3, 6.5), 2.3, "leaf_a"),
        ((-0.6, -2.2, 6.3), 2.2, "leaf_b"),
        ((1.3, -1.4, 8.0), 2.0, "leaf_c"),
        ((-0.5, 0.6, 8.9), 2.0, "leaf_c"),
    ]
    for c, r, slot in canopy:
        b.blob(Vector(c) + lean, r, slot)
    return b.to_object("Tree_Large", col, {"plant_kind": "tree_large", "label_ko": "큰 나무", "height_m": 10.7})


def make_medium_tree(col):
    """Conical evergreen, about 5 m tall."""
    b = Builder(["bark", "conifer_a", "conifer_b"])
    b.tube([Vector((0, 0, 0)), Vector((0, 0, 1.2)), Vector((0, 0, 2.4))], [0.22, 0.16, 0.12], 6, "bark")
    for z0, r, h, slot in ((0.95, 1.55, 2.0, "conifer_a"), (2.1, 1.2, 1.85, "conifer_b"), (3.15, 0.85, 1.9, "conifer_a")):
        b.cone(z0, r, h, slot)
    return b.to_object("Tree_Medium", col, {"plant_kind": "tree_medium", "label_ko": "중간 나무", "height_m": 5.05})


def make_small_grass(col):
    """Tuft of grass blades, about 0.4 m tall."""
    b = Builder(["grass_a", "grass_b"])
    blades = 16
    for i in range(blades):
        yaw = 2 * math.pi * i / blades + rng.uniform(-0.25, 0.25)
        h = rng.uniform(0.24, 0.46)
        w = rng.uniform(0.035, 0.05)
        bend = rng.uniform(0.12, 0.42) * h
        out = Vector((math.cos(yaw), math.sin(yaw), 0))
        side = Vector((-math.sin(yaw), math.cos(yaw), 0))
        root = out * rng.uniform(0.0, 0.05)

        def p(t):
            return root + out * (bend * t * t) + Vector((0, 0, h * t))

        b0 = b.bm.verts.new(p(0) - side * w / 2)
        b1 = b.bm.verts.new(p(0) + side * w / 2)
        m0 = b.bm.verts.new(p(0.55) - side * w * 0.32)
        m1 = b.bm.verts.new(p(0.55) + side * w * 0.32)
        tip = b.bm.verts.new(p(1.0))
        slot = "grass_a" if i % 2 else "grass_b"
        b.face((b0, b1, m1, m0), slot)
        b.face((m0, m1, tip), slot)
    return b.to_object("Grass_Small", col, {"plant_kind": "grass_small", "label_ko": "작은 풀", "height_m": 0.46})


# ---------------------------------------------------------------- scene, preview, export

def fresh_scene():
    """Use the empty factory-startup scene of a new file."""
    if not bpy.app.background:
        raise RuntimeError("Run this script with blender -b --factory-startup (see the docstring).")
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene.name = SCENE_NAME
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    plants = bpy.data.collections.new("Plants")
    preview = bpy.data.collections.new("Preview")
    scene.collection.children.link(plants)
    scene.collection.children.link(preview)
    return scene, plants, preview


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_preview(scene, col, grass_pos):
    world = bpy.data.worlds.get("PL_Preview_World") or bpy.data.worlds.new("PL_Preview_World")
    if world.node_tree is None:
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = srgb("#DCE9F2")
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world

    me = bpy.data.meshes.new("Preview_Ground")
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, radius=11, segments=40)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material("PL_Preview_Ground", "#B9CF9C", 1.0))
    ground = bpy.data.objects.new("Preview_Ground", me)
    col.objects.link(ground)

    sun_data = bpy.data.lights.new("Preview_Sun", "SUN")
    sun_data.energy = 3.2
    sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new("Preview_Sun", sun_data)
    sun.rotation_euler = (math.radians(48), 0, math.radians(-35))
    col.objects.link(sun)

    cams = {}
    for name, loc, target, lens in (
        ("Preview_Camera", (15.5, -17.0, 7.5), (-0.6, 0.0, 4.0), 38),
        ("Preview_Camera_Grass", (grass_pos[0] + 0.85, grass_pos[1] - 1.0, 0.45), (grass_pos[0], grass_pos[1], 0.17), 50),
    ):
        data = bpy.data.cameras.new(name)
        data.lens = lens
        cam = bpy.data.objects.new(name, data)
        cam.location = loc
        look_at(cam, target)
        col.objects.link(cam)
        cams[name] = cam

    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y, r.resolution_percentage = 1280, 800, 100
    r.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.eevee.taa_render_samples = 32
    return cams


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export_glb(scene, obj, path):
    """Export one plant at the origin. The scene is the active scene of this background session."""
    keep = obj.location.copy()
    obj.location = (0, 0, 0)
    for o in scene.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_extras=True, export_cameras=False, export_lights=False,
        export_image_format="NONE", export_animations=False)
    obj.select_set(False)
    obj.location = keep


def main():
    os.makedirs(GLB_DIR, exist_ok=True)
    os.makedirs(ASSET_DIR, exist_ok=True)
    scene, plants, preview = fresh_scene()

    large = make_large_tree(plants)
    medium = make_medium_tree(plants)
    grass = make_small_grass(plants)
    large.location = (-4.0, 1.0, 0)
    medium.location = (4.2, 2.2, 0)
    grass.location = (1.6, -3.2, 0)
    cams = setup_preview(scene, preview, grass.location)
    bpy.context.view_layer.update()

    report = {}
    for obj, fname in ((large, "tree_large.glb"), (medium, "tree_medium.glb"), (grass, "grass_small.glb")):
        path = os.path.join(GLB_DIR, fname)
        export_glb(scene, obj, path)
        report[obj.name] = {"tris": tri_count(obj), "size_m": [round(d, 2) for d in obj.dimensions], "glb_bytes": os.path.getsize(path)}

    for cam_name, fname in (("Preview_Camera", "plants_lowpoly_preview.png"), ("Preview_Camera_Grass", "plants_lowpoly_grass.png")):
        scene.camera = cams[cam_name]
        scene.render.filepath = os.path.join(ASSET_DIR, fname)
        bpy.ops.render.render(write_still=True)
    scene.camera = cams["Preview_Camera"]

    blend_path = os.path.join(ASSET_DIR, "plants_lowpoly.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=True)
    print("PLANTS_REPORT", report)
    print("PLANTS_BLEND", blend_path)


main()

