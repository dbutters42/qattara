// Water surface pass. Shares the terrain mesh topology; reads the live water
// depth straight out of the M3 simulation's storage buffer (see
// src/sim/water.ts) rather than a CPU-uploaded texture.

struct Uniforms {
  viewProj: mat4x4<f32>,
  fieldCols: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> waterBuf: array<f32>;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) waterDepth: f32,
};

@vertex
fn vs_main(@location(0) groundPos: vec2<f32>, @location(1) texel: vec2<f32>) -> VertexOutput {
  let col = i32(texel.x);
  let row = i32(texel.y);
  let terrainHeight = textureLoad(heightTex, vec2<i32>(col, row), 0).r;
  let waterDepth = waterBuf[row * i32(uniforms.fieldCols) + col];
  // Never render the surface below the terrain even where there's no water —
  // avoids z-fighting with the terrain pass on dry cells (which discard anyway).
  let surfaceY = terrainHeight + max(waterDepth, 0.0);

  var out: VertexOutput;
  out.clipPos = uniforms.viewProj * vec4<f32>(groundPos.x, surfaceY, groundPos.y, 1.0);
  out.waterDepth = waterDepth;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  if (in.waterDepth <= 0.001) {
    discard;
  }
  // Arbitrary reference depth for the shallow->deep ramp — not physically
  // calibrated, just enough to read as water. Revisit at M5.
  let depthNorm = clamp(in.waterDepth / 8.0, 0.0, 1.0);
  let shallow = vec3<f32>(0.4, 0.7, 0.8);
  let deep = vec3<f32>(0.05, 0.2, 0.35);
  let color = mix(shallow, deep, depthNorm);
  let alpha = mix(0.55, 0.9, depthNorm);
  return vec4<f32>(color, alpha);
}
