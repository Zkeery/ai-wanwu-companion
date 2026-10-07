export const oasisKinds = ['palm','cactus','rock','pond','shade','cushion','tea_table','tent','string_lights','sign','bench','flowerpot','tree'];
export const crops = [[28,0,339,379],[393,15,289,370],[721,99,349,267],[1080,90,366,285],[3,383,387,322],[393,477,339,224],[754,445,311,254],[1084,383,351,321],[8,733,379,295],[430,703,267,334],[721,778,353,260],[1106,716,327,331]];
export const widths = [22,12,15,32,29,11,13,24,25,11,18,10,12];
export const templates = {
 water: [['palm',23,56],['pond',35,73],['shade',72,57],['tea_table',70,72],['cushion',80,79],['cactus',12,79],['flowerpot',85,57],['rock',46,60],['bench',26,88],['sign',83,90]],
 camp: [['palm',20,58],['tent',37,60],['string_lights',70,47],['tea_table',65,71],['cushion',72,80],['cushion',54,76],['flowerpot',45,89],['cactus',86,65],['rock',13,81],['sign',82,91]],
} satisfies Record<string, [string, number, number][]>;
export type Template = keyof typeof templates;
export function groundPoint(clientX: number, clientY: number, rect: {left:number;top:number;width:number;height:number}) {
 const x = ((clientX-rect.left)/rect.width*100-9)/82, y=((clientY-rect.top)/rect.height*100-44)/49;
 return rect.width > 0 && rect.height > 0 && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? {x: Math.round(x*1000)/1000,y:Math.round(y*1000)/1000} : null;
}
