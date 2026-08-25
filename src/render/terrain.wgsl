struct Uniforms {
  viewProj: mat4x4<f32>,
  // xyz = directional light vector (toward the light), w unused.
  lightDir: vec4<f32>,
  // World-space distance between adjacent height-field texels, x = column, y = row.
  worldStep: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightTex: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) texel: vec2<f32>,
};

@vertex
fn vs_main(@location(0) groundPos: vec2<f32>, @location(1) texel: vec2<f32>) -> VertexOutput {
  let coord = vec2<i32>(i32(texel.x), i32(texel.y));
  let height = textureLoad(heightTex, coord, 0).r;
  let worldPos = vec3<f32>(groundPos.x, height, groundPos.y);

  var out: VertexOutput;
  out.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  out.texel = texel;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Direct texel fetches, no sampler — exact per-cell values, not
  // interpolated ones. Correct for a heightfield that will later be a
  // compute-shader-updated simulation grid, and sidesteps the
  // float32-filterable optional-feature question entirely.
  let base = vec2<i32>(i32(round(in.texel.x)), i32(round(in.texel.y)));
  let hL = textureLoad(heightTex, base + vec2<i32>(-1, 0), 0).r;
  let hR = textureLoad(heightTex, base + vec2<i32>(1, 0), 0).r;
  let hD = textureLoad(heightTex, base + vec2<i32>(0, -1), 0).r;
  let hU = textureLoad(heightTex, base + vec2<i32>(0, 1), 0).r;

  let dHdx = (hR - hL) / (2.0 * uniforms.worldStep.x);
  let dHdz = (hU - hD) / (2.0 * uniforms.worldStep.y);
  let normal = normalize(vec3<f32>(-dHdx, 1.0, -dHdz));

  let lightDir = normalize(uniforms.lightDir.xyz);
  let diffuse = max(dot(normal, lightDir), 0.0);
  let ambient = 0.3;

  // Placeholder single earth tone — per-material colour arrives with M2's brushes.
  let baseColor = vec3<f32>(0.55, 0.5, 0.4);
  let color = baseColor * (ambient + diffuse * 0.75);
  return vec4<f32>(color, 1.0);
}
