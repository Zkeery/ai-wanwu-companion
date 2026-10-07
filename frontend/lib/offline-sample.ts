// Synthetic red PNG for the isolated preview. It does not represent a recognized object.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAIAAAC2BqGFAAABIElEQVR4nO3SQQ0AIAADMUAmIvCME1Rwr9bAksvm3Wfw3wo2ELrj0RGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCB0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCB0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCB0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCB0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCD0aD/upApljIg78AAAAAElFTkSuQmCC';

export function offlineSampleFile(): File {
  return new File([Uint8Array.from(atob(PNG), ch => ch.charCodeAt(0))], '模拟示意图.png', { type: 'image/png' });
}
