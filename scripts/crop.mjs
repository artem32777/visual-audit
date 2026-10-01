import { PNG } from 'pngjs';
import { assert, cli, readPng, savePng } from './common.mjs';

export const crop = async (input, output, ...coordinates) => {
  const [x,y,width,height] = coordinates.map(Number);
  assert(input && output && coordinates.length === 4 && [x,y,width,height].every(Number.isInteger), 'Usage: crop.mjs input.png output.png x y width height (integers)');
  const png = await readPng(input);
  assert(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= png.width && y + height <= png.height, 'Crop must lie inside original image');
  const result = new PNG({ width, height });
  PNG.bitblt(png, result, x, y, width, height, 0, 0);
  await savePng(output, result);
  console.log(output);
};
cli(import.meta.url, crop);
