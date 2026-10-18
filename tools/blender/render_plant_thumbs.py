"""Render transparent thumbnails of the web plant models for the "식물 추가" model picker.

    blender -b --factory-startup --python tools/blender/render_plant_thumbs.py

It imports public/models/plants/*.glb (the same files the site loads), so the pictures always
match what is shown on the map, and writes public/models/plants/thumbs/<kind>.png.
"""
import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GLB_DIR = os.path.join(ROOT, "public", "models", "plants")
OUT_DIR = os.path.join(GLB_DIR, "thumbs")
KINDS = ("tree_large", "tree_medium", "grass_small")
SIZE = 320


def linear(hex_color):
    out = []
    for i in (1, 3, 5):
        c = int(hex_color[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


os.makedirs(OUT_DIR, exist_ok=True)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
scene.eevee.taa_render_samples = 32

world = bpy.data.worlds.new("Thumb_World")
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = linear("#DCE9F2")
scene.world = world

sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 3.2
sun.rotation_euler = (math.radians(48), 0, math.radians(-35))
scene.collection.objects.link(sun)
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 50
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
half_fov = math.atan(cam_data.sensor_width / 2 / cam_data.lens)

for kind in KINDS:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(GLB_DIR, kind + ".glb"))
    new = [o for o in bpy.data.objects if o not in before]
    pts = [o.matrix_world @ Vector(c) for o in new if o.type == "MESH" for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    radius = (hi - lo).length / 2 * 1.02
    direction = Vector((0.75, -1.0, 0.42)).normalized()
    cam.location = center + direction * (radius / math.sin(half_fov))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = radius * 20
    scene.render.filepath = os.path.join(OUT_DIR, kind + ".png")
    bpy.ops.render.render(write_still=True)
    for o in new:
        bpy.data.objects.remove(o)
    print("THUMB", kind, scene.render.filepath)
