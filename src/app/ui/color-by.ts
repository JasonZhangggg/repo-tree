import { ICONS } from '../dom';

/** How each way of coloring leaves is named, hinted and drawn, in Settings and the side panel. */
export const COLOR_BY_LABEL = {
  language: 'Language',
  folder: 'Folder',
  activity: 'Activity',
  changes: 'Changes',
  owner: 'Owner',
};
export const COLOR_BY_HINT = {
  language: 'File type',
  folder: 'Top-level folder',
  activity: 'Last change',
  changes: 'How often it changed',
  owner: 'Code owner',
};
export const COLOR_BY_ICON = {
  language: ICONS.code,
  folder: ICONS.folder,
  activity: ICONS.clock,
  changes: ICONS.pulse,
  owner: ICONS.person,
};
