// One shared arrow icon so both engines draw the exact same sprite.
export const ICON_SIZE = 48;

export function makeArrowCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_SIZE;
  c.height = ICON_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(ICON_SIZE / 2, 4);
  ctx.lineTo(ICON_SIZE - 8, ICON_SIZE - 6);
  ctx.lineTo(ICON_SIZE / 2, ICON_SIZE - 16);
  ctx.lineTo(8, ICON_SIZE - 6);
  ctx.closePath();
  ctx.fill();
  return c;
}

export function arrowImageData(): ImageData {
  const c = makeArrowCanvas();
  return c.getContext('2d')!.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
}
