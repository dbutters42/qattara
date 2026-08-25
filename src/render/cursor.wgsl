struct Uniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Vertices are already full world-space positions, one height sample per
// point computed on the CPU (main.ts) each time the ring moves — matches
// the terrain surface instead of sitting flat at a single height.
@vertex
fn vs_main(@location(0) worldPos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return uniforms.viewProj * vec4<f32>(worldPos, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 0.6);
}
