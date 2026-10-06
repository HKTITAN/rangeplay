// tile-world's GPU commands, run by the GPU worker (src/gpu-worker.js): OP_UPLOAD copies a streamed tile from shared
// memory into a 4096 x 4096 atlas texture, OP_DRAW draws the visible tiles as instanced quads. With no WebGPU the
// same commands draw on a 2D canvas.

const OP_UPLOAD = 16, OP_DRAW = 17;
const ATLAS = 4096, TILE = 128, PER_ROW = ATLAS / TILE, INSTANCE_BYTES = 20, MAX_INSTANCES = 4096;

const WGSL = /* wgsl */ `
struct U { view: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) slot: i32,
  @location(2) colour: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f, @location(1) size: f32,
              @location(2) slot: i32, @location(3) colour: vec4f) -> V {
  var corner = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let c = corner[vi];
  let px = p + c * size;
  var o: V;
  o.pos = vec4f(px.x / u.view.x * 2.0 - 1.0, 1.0 - px.y / u.view.y * 2.0, 0.0, 1.0);
  let cell = vec2f(f32(slot % ${PER_ROW}), f32(slot / ${PER_ROW})) * ${TILE}.0;
  o.uv = (cell + 0.5 + c * ${TILE - 1}.0) / ${ATLAS}.0;   // half-texel inset: no bleeding from neighbours
  o.slot = slot;
  o.colour = colour;
  return o;
}

@fragment fn fs(v: V) -> @location(0) vec4f {
  let t = textureSampleLevel(atlas, samp, v.uv, 0.0);
  return select(t, v.colour, v.slot < 0);
}
`;

export async function setup(ctx) {
  return ctx.backend === 'webgpu' ? setupWebGPU(ctx) : setup2D(ctx);
}

function setupWebGPU(ctx) {
  const { device, context, format } = ctx;
  const atlas = device.createTexture({ size: [ATLAS, ATLAS], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const instances = device.createBuffer({ size: MAX_INSTANCES * INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [{
        arrayStride: INSTANCE_BYTES,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32' },
          { shaderLocation: 2, offset: 12, format: 'sint32' },
          { shaderLocation: 3, offset: 16, format: 'unorm8x4' },
        ],
      }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: atlas.createView() },
      { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ],
  });

  // WebGPU accepts views on shared memory for these copies; if a browser does not, copy through a private buffer.
  let shared = true;
  const source = (at, n) => (shared ? ctx.u8.subarray(at, at + n) : ctx.u8.slice(at, at + n));
  const tryShared = (fn) => {
    try {
      fn();
    } catch (e) {
      if (!shared) throw e;
      shared = false;
      ctx.log('[tile-world] copying through private buffers (' + e.message + ')');
      fn();
    }
  };

  let count = 0;
  return {
    [OP_UPLOAD](at) {
      const slot = ctx.dv.getUint32(at, true), src = ctx.dv.getUint32(at + 4, true), size = ctx.dv.getUint32(at + 8, true);
      tryShared(() => device.queue.writeTexture(
        { texture: atlas, origin: [(slot % PER_ROW) * TILE, Math.floor(slot / PER_ROW) * TILE] },
        source(src, size * size * 4),
        { bytesPerRow: size * 4, rowsPerImage: size },
        [size, size],
      ));
    },
    [OP_DRAW](at) {
      device.queue.writeBuffer(uniforms, 0, new Float32Array([ctx.dv.getFloat32(at, true), ctx.dv.getFloat32(at + 4, true), 0, 0]));
      count = Math.min(MAX_INSTANCES, ctx.dv.getUint32(at + 8, true));
      if (count) tryShared(() => device.queue.writeBuffer(instances, 0, source(at + 16, count * INSTANCE_BYTES)));
    },
    frame() {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0.06, g: 0.13, b: 0.27, a: 1 }, storeOp: 'store' }],
      });
      if (count) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, instances);
        pass.draw(6, count);
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    },
  };
}

function setup2D(ctx) {
  const { canvas, ctx2d } = ctx;
  const atlas = new OffscreenCanvas(ATLAS, ATLAS);
  const actx = atlas.getContext('2d');
  let dpr = 1, items = new Uint8Array(0), count = 0;
  return {
    resize(w, h, d) {
      dpr = d;
    },
    [OP_UPLOAD](at) {
      const slot = ctx.dv.getUint32(at, true), src = ctx.dv.getUint32(at + 4, true), size = ctx.dv.getUint32(at + 8, true);
      const pixels = new Uint8ClampedArray(ctx.u8.slice(src, src + size * size * 4).buffer);   // ImageData needs private memory
      actx.putImageData(new ImageData(pixels, size, size), (slot % PER_ROW) * TILE, Math.floor(slot / PER_ROW) * TILE);
    },
    [OP_DRAW](at) {
      count = Math.min(MAX_INSTANCES, ctx.dv.getUint32(at + 8, true));
      items = ctx.u8.slice(at + 16, at + 16 + count * INSTANCE_BYTES);
    },
    frame() {
      const dv = new DataView(items.buffer);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.fillStyle = '#10223f';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < count; i++) {
        const o = i * INSTANCE_BYTES;
        const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), s = dv.getFloat32(o + 8, true), slot = dv.getInt32(o + 12, true);
        if (slot >= 0) {
          ctx2d.drawImage(atlas, (slot % PER_ROW) * TILE, Math.floor(slot / PER_ROW) * TILE, TILE, TILE, x, y, s + 0.5, s + 0.5);
        } else {
          ctx2d.fillStyle = `rgb(${items[o + 16]},${items[o + 17]},${items[o + 18]})`;
          ctx2d.fillRect(x, y, s + 0.5, s + 0.5);
        }
      }
    },
  };
}
