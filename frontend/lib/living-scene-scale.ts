/** One world ruler for the three cartoon scenes. Only home opts in until visual approval. */
const doorHeight = 2.35;
const companionHeight = doorHeight / 2;
export const SCENE_SCALE = Object.freeze({
  unit: 1,
  doorHeight,
  companionHeight,
  authoredFigureHeight: 1.7,
  authoredStandeeHeight: 1.72,
  seatHeight: companionHeight * .31,
  seatWidth: companionHeight * .6,
  stoolDiameter: companionHeight * .5,
  tableHeight: companionHeight * .51,
  tableWidth: companionHeight * .94,
  smallPropMaxHeight: companionHeight * .8,
  treeMaxHeight: doorHeight * 3.2,
  bevel: companionHeight * .065,
  grassHeight: companionHeight * .13,
  pebbleHeight: companionHeight * .045,
  pathWidth: companionHeight * .8,
});

export const HOME_CARTOON_CAMERA = Object.freeze({
  target: [-.1, 1.9, 1.3] as const,
  position: [3.84, 4.79, 10.84] as const,
});
