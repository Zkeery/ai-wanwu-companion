import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import CreateCompanion from '@/components/create-companion';
import { creationApi, DRAFT_KEY, GenerationFailedError, generateCompanion } from '@/lib/creation';
import { api, ApiError } from '@/lib/api';
import { loadPrivateMotion } from '@/lib/private-motion';
import { privateImageBlob } from '@/lib/private-images';
import { setToken } from '@/lib/auth';
import { loadPreparedActivityMotion, readMotionPreparation } from '@/lib/motion-preparation';
vi.mock('@/lib/motion-preparation', async original => ({
  ...await original<typeof import('@/lib/motion-preparation')>(),
  readMotionPreparation: vi.fn(async () => ({ rest: 'waiting_source', walk: 'ready', observe: 'waiting_source' })),
  loadPreparedActivityMotion: vi.fn(async () => ({ asset: null, dispose: vi.fn() })),
}));
vi.mock('@/lib/private-motion', () => ({ loadPrivateMotion: vi.fn(), loadPrivateMotionShared: vi.fn() }));
vi.mock('@/lib/private-images', () => ({ privateImageBlob: vi.fn(async () => new Blob(['image'], { type: 'image/png' })) }));

vi.mock('@/lib/creation', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/creation')>(), creationApi: { upload: vi.fn(), correction: vi.fn(), photo: vi.fn(), receipt: vi.fn(), byObject: vi.fn(), rename: vi.fn() }, generateCompanion: vi.fn() }));
const photo = { id: 1, status: 'done', objects: [{ id: 2, label: '杯子' }, { id: 3, label: '植物' }] };
const character = { id: 9, name: '小杯', persona: '温柔', opening_line: '你好', image_path: null, status: 'ready' as const, created_at: '' };
it('checks exhausted credits before any recognition or generation call', async () => {
  vi.mocked(api.generationCredits).mockResolvedValue({ enabled: true, available: 0 });
  render(<CreateCompanion />);
  fireEvent.change(await screen.findByLabelText('选择照片'), { target: { files: [new File(['photo'], 'cup.jpg', { type: 'image/jpeg' })] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并生成伙伴' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('生成额度已用完');
  expect(creationApi.upload).not.toHaveBeenCalled(); expect(generateCompanion).not.toHaveBeenCalled();
});
const draft = { requestId: '11111111-1111-4111-8111-111111111111', photoId: 1, objectId: 2, label: '米白陶瓷杯' };
it('shows service pause separately from retained credits and prevents upload', async () => {
  vi.mocked(api.generationCredits).mockResolvedValue({ enabled: true, available: 4,
    model_available: false, unavailable_message: 'AI服务已暂停，已有伙伴和记录仍可查看。' });
  render(<CreateCompanion />);
  expect(await screen.findByRole('alert')).toHaveTextContent('AI服务已暂停');
  expect(screen.getByText('账户保留 4 次生成额度，服务恢复后可用。')).toBeVisible();
  expect(screen.getByLabelText('选择照片')).toBeDisabled();
  expect(screen.getByRole('button', { name: '上传并生成伙伴' })).toBeDisabled();
  expect(creationApi.upload).not.toHaveBeenCalled();
});
it.each(['ready', 'generating'] as const)('checks hidden historical object results before selection: %s', async status => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, objectId: 6 }));
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, status });
  render(<CreateCompanion />);
  expect(await screen.findByText(status === 'ready' ? '已加入我的伙伴' : /伙伴仍在生成中/)).toBeInTheDocument();
  expect(creationApi.byObject).toHaveBeenCalledWith(6, expect.any(AbortSignal));
  expect(generateCompanion).not.toHaveBeenCalled();
});
it.each([null, 'failed'] as const)('requires a new selection for a hidden object without a usable result: %s', async status => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, objectId: 6 }));
  vi.mocked(creationApi.photo).mockResolvedValue({ ...photo, objects: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: `物品${i + 1}` })) });
  vi.mocked(creationApi.byObject).mockResolvedValue(status ? { ...character, status } : null);
  render(<CreateCompanion />);
  expect(await screen.findByText('上次选择的对象不在当前候选中，请重新选择。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '物品6' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '物品1' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByLabelText('对象描述')).toHaveValue('');
  expect(screen.getByRole('button', { name: '生成伙伴' })).toBeDisabled();
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).not.toHaveProperty('objectId');
  expect(generateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '物品2' }));
  expect(screen.getByRole('button', { name: '生成伙伴' })).toBeEnabled();
});
beforeEach(() => { vi.clearAllMocks();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  vi.mocked(loadPrivateMotion).mockResolvedValue({ asset: null, dispose: vi.fn() }); sessionStorage.clear(); setToken('synthetic-test-session'); vi.spyOn(api, 'generationCredits').mockResolvedValue({ enabled: false, available: null }); vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'test-user', phone: '13900000001' }); URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn(); vi.mocked(creationApi.upload).mockResolvedValue(photo); vi.mocked(creationApi.photo).mockResolvedValue(photo); vi.mocked(creationApi.byObject).mockResolvedValue(null); vi.mocked(generateCompanion).mockResolvedValue(character); });
it('does not recover a saved draft before authentication is checked', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  vi.mocked(api.auth.me).mockRejectedValueOnce(new ApiError('请先登录', 401, 'unauthorized'));
  render(<CreateCompanion />);
  await screen.findByRole('button', { name: /注册 \/ 登录/ });
  expect(creationApi.photo).not.toHaveBeenCalled();
});
async function selectPhoto() { fireEvent.change(await screen.findByLabelText('选择照片'), { target: { files: [new File(['image'], 'cup.png', { type: 'image/png' })] } }); }
it('shows a confirmed recognition failure, retains the file, and retries only when clicked', async () => {
  vi.mocked(creationApi.upload).mockRejectedValueOnce(new ApiError('识别服务的连接中断了，本次未完成识别，请稍后重试。', 502, 'recognize_failed'));
  render(<CreateCompanion />); await selectPhoto();
  fireEvent.click(screen.getByRole('button', { name: '上传并生成伙伴' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('识别服务的连接中断');
  expect(screen.getByText('已选择：cup.png')).toBeVisible();
  expect(creationApi.upload).toHaveBeenCalledTimes(1); expect(generateCompanion).not.toHaveBeenCalled();
  const first = vi.mocked(creationApi.upload).mock.calls[0];
  fireEvent.click(screen.getByRole('button', { name: '上传并生成伙伴' }));
  await waitFor(() => expect(creationApi.upload).toHaveBeenCalledTimes(2));
  const second = vi.mocked(creationApi.upload).mock.calls[1];
  expect(second[0]).toBe(first[0]); expect(second[1]).not.toBe(first[1]);
  await waitFor(() => expect(generateCompanion).toHaveBeenCalledTimes(1));
});
it('treats a proxy 502 as unknown and checks the receipt instead of reuploading', async () => {
  vi.mocked(creationApi.upload).mockRejectedValueOnce(new ApiError('暂时连接不上', 502, 'request_failed'));
  vi.mocked(creationApi.receipt).mockResolvedValue({ status: 'running', photo: null });
  render(<CreateCompanion />); await selectPhoto();
  fireEvent.click(screen.getByRole('button', { name: '上传并生成伙伴' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('照片可能已经识别完成');
  expect(screen.queryByRole('button', { name: '上传并生成伙伴' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '核对结果' }));
  await waitFor(() => expect(creationApi.receipt).toHaveBeenCalledTimes(1));
  expect(creationApi.upload).toHaveBeenCalledTimes(1); expect(generateCompanion).not.toHaveBeenCalled();
});
async function reachObjects() {
  // Enter the correction flow after a successful automatic creation.
  const implementation = vi.mocked(generateCompanion).getMockImplementation();
  vi.mocked(generateCompanion).mockResolvedValue(character);
  await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  await screen.findByText('已加入我的伙伴');
  const recognized = await vi.mocked(creationApi.upload).mock.results[0].value;
  vi.mocked(creationApi.correction).mockResolvedValue(recognized);
  fireEvent.click(screen.getByText('纠正对象或特征'));
  fireEvent.click(await screen.findByRole('button', { name: '杯子' }));
  vi.mocked(generateCompanion).mockReset();
  if (implementation) vi.mocked(generateCompanion).mockImplementation(implementation);
  else vi.mocked(generateCompanion).mockResolvedValue(character);
}
it('explains a slow recognition without resubmitting and clears the wait on success', async () => {
  let finish!: (value: typeof photo) => void;
  vi.mocked(creationApi.upload).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<CreateCompanion />); await selectPhoto();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByText('上传并生成伙伴'));
    expect(screen.getByText('已等待 0 秒')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在识别…' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(21000); });
    expect(screen.getByText('已等待 21 秒')).toBeInTheDocument();
    expect(screen.getByText('原识别请求仍在等待结果，不用重复上传。')).toBeInTheDocument();
    expect(creationApi.upload).toHaveBeenCalledTimes(1);
    await act(async () => { finish(photo); });
    expect(screen.getByText('已加入我的伙伴')).toBeInTheDocument();
    expect(screen.queryByText(/已等待/)).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});
it('keeps a rejected image on the upload step and allows choosing a replacement without auto retry', async () => {
  vi.mocked(creationApi.upload).mockRejectedValueOnce(new ApiError('图片长边不能超过 4096px，请缩小后重新选择', 400, 'image_dimensions'));
  render(<CreateCompanion />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  expect(await screen.findByText('图片长边不能超过 4096px，请缩小后重新选择')).toBeInTheDocument();
  expect(creationApi.upload).toHaveBeenCalledTimes(1); expect(generateCompanion).not.toHaveBeenCalled();
  await selectPhoto(); expect(creationApi.upload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('上传并生成伙伴')); expect(await screen.findByText('已加入我的伙伴')).toBeInTheDocument();
});
it('locks upload and generation immediately and sends the corrected label', async () => {
  let finish!: (value: typeof character) => void;
  vi.mocked(generateCompanion).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<CreateCompanion />); await reachObjects(); expect(creationApi.upload).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('对象描述'), { target: { value: '米白陶瓷杯' } });
  const button = screen.getByText('生成伙伴'); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(generateCompanion).toHaveBeenCalledTimes(1)); expect(vi.mocked(generateCompanion).mock.calls[0].slice(0, 2)).toEqual([2, '米白陶瓷杯']);
  finish(character); expect(await screen.findByText('已加入我的伙伴')).toBeInTheDocument(); expect(screen.getByText('开始聊天')).toHaveAttribute('href', '/companions/9');
});
it('recovers a lost generation response through a read without repeating generation', async () => {
  vi.mocked(generateCompanion).mockRejectedValue(new Error('连接中断')); vi.mocked(creationApi.byObject).mockResolvedValue(character);
  render(<CreateCompanion />); await reachObjects(); fireEvent.click(screen.getByText('生成伙伴')); fireEvent.click(await screen.findByText('核对结果'));
  expect(await screen.findByText('已加入我的伙伴')).toBeInTheDocument(); expect(generateCompanion).toHaveBeenCalledTimes(1);
});
it('refresh restores pending generation and never sends a write', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, status: 'generating' });
  render(<CreateCompanion />); expect(await screen.findByText(/伙伴仍在生成中/)).toBeInTheDocument(); expect(generateCompanion).not.toHaveBeenCalled(); expect(creationApi.upload).not.toHaveBeenCalled();
});
it('only offers retry after the server reports failed', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, status: 'failed' });
  render(<CreateCompanion />); const button = await screen.findByText('生成伙伴'); expect(screen.getByLabelText('对象描述')).toHaveValue('米白陶瓷杯'); expect(generateCompanion).not.toHaveBeenCalled(); fireEvent.click(button); expect(await screen.findByText('已加入我的伙伴')).toBeInTheDocument();
});
it('keeps uncertain upload locked until receipt is checked', async () => {
  vi.mocked(creationApi.upload).mockRejectedValue(new Error('网络中断')); vi.mocked(creationApi.receipt).mockResolvedValue({ status: 'ready', photo });
  render(<CreateCompanion />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴')); fireEvent.click(await screen.findByText('核对结果')); expect(await screen.findByText('这次想和谁交朋友？')).toBeInTheDocument(); expect(creationApi.upload).toHaveBeenCalledTimes(1);
});
it('preserves an uncertain name edit and requires a read before saving again', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); vi.mocked(creationApi.byObject).mockResolvedValue(character); vi.mocked(creationApi.rename).mockRejectedValue(new Error('网络中断'));
  render(<CreateCompanion />); fireEvent.change(await screen.findByLabelText('给伙伴一个喜欢的名字'), { target: { value: '小暖' } }); fireEvent.click(screen.getByText('保存名字')); const check = await screen.findByText('核对名字'); expect(screen.getByText('保存名字')).toBeDisabled();
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, name: '小暖' }); fireEvent.click(check); expect(await screen.findByLabelText('给伙伴一个喜欢的名字')).toHaveValue('小暖'); expect(creationApi.rename).toHaveBeenCalledTimes(1);
});
it('aborts waiting and frees the preview URL when leaving', async () => {
  let signal: AbortSignal | undefined; vi.mocked(creationApi.upload).mockImplementation((_file, _key, s) => { signal = s; return new Promise(() => {}); });
  const view = render(<CreateCompanion />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴')); await waitFor(() => expect(creationApi.upload).toHaveBeenCalledTimes(1)); view.unmount(); expect(signal?.aborted).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test'); expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
});

it('switches photo features with the selected object and sends the correction', async () => {
  vi.mocked(creationApi.upload).mockResolvedValue({ ...photo, objects: [{ id: 2, label: '杯子', visual_features: '粉色，白色圆点' }, { id: 3, label: '苹果', visual_features: '绿色，圆形' }] });
  render(<CreateCompanion />); await reachObjects();
  expect(screen.getByLabelText('照片里的特征')).toHaveValue('粉色，白色圆点');
  fireEvent.click(screen.getByRole('button', { name: '苹果' }));
  expect(screen.getByLabelText('照片里的特征')).toHaveValue('绿色，圆形');
  fireEvent.change(screen.getByLabelText('照片里的特征'), { target: { value: '红色，有小斑点' } });
  fireEvent.click(screen.getByText('生成伙伴'));
  await screen.findByText('已加入我的伙伴');
  expect(vi.mocked(generateCompanion).mock.calls[0][4]).toBe('红色，有小斑点');
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ objectId: 3, visualFeatures: '红色，有小斑点' });
});

it('restores an explicitly cleared feature draft without reintroducing recognized details', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, visualFeatures: '' }));
  vi.mocked(creationApi.photo).mockResolvedValue({ ...photo, objects: [{ id: 2, label: '杯子', visual_features: '旧特征' }] });
  const view = render(<CreateCompanion />);
  expect(await screen.findByLabelText('照片里的特征')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('照片里的特征'), { target: { value: '用户修改的特征' } });
  view.unmount(); render(<CreateCompanion />);
  expect(await screen.findByLabelText('照片里的特征')).toHaveValue('用户修改的特征');
  expect(generateCompanion).not.toHaveBeenCalled();
});

it('lets a legacy photo proceed with an honest empty-feature explanation', async () => {
  render(<CreateCompanion />); await reachObjects();
  expect(screen.getByLabelText('照片里的特征')).toHaveValue('');
  expect(screen.getByText(/这张照片没有保存可用的特征/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成伙伴' })).toBeEnabled();
});

it('returns a confirmed generation failure to object confirmation with edits intact and no auto retry', async () => {
  render(<CreateCompanion />); await reachObjects();
  vi.mocked(generateCompanion).mockRejectedValueOnce(new GenerationFailedError('生成服务响应超时，本次未能完成。', 9));
  fireEvent.change(screen.getByLabelText('对象描述'), { target: { value: '粉色杯子' } });
  fireEvent.change(screen.getByLabelText('照片里的特征'), { target: { value: '白色小圆点' } });
  fireEvent.click(screen.getByRole('button', { name: '生成伙伴' }));
  await screen.findByText(/生成服务响应超时/);
  expect(screen.getByLabelText('对象描述')).toHaveValue('粉色杯子');
  expect(screen.getByLabelText('照片里的特征')).toHaveValue('白色小圆点');
  expect(screen.getByRole('button', { name: '生成伙伴' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '核对结果' })).not.toBeInTheDocument();
  expect(generateCompanion).toHaveBeenCalledTimes(1);
});


it('automatically generates the primary object exactly once with unchanged photo features', async () => {
  vi.mocked(creationApi.upload).mockResolvedValue({ ...photo, objects: [{ id: 2, label: '杯子', visual_features: '粉色圆点' }, { id: 3, label: '苹果' }] });
  render(<CreateCompanion />); await selectPhoto();
  const button = screen.getByText('上传并生成伙伴');
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('已加入我的伙伴');
  expect(creationApi.upload).toHaveBeenCalledTimes(1);
  expect(generateCompanion).toHaveBeenCalledTimes(1);
  expect(vi.mocked(generateCompanion).mock.calls[0]).toEqual([2, '杯子', expect.any(AbortSignal), expect.any(Function), '粉色圆点', false]);
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ photoId: 1, objectId: 2, visualFeatures: '粉色圆点' });
});

it('prepares a correction without regenerating or uploading and recovers a lost correction response', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  vi.mocked(creationApi.byObject).mockResolvedValue(character);
  vi.mocked(creationApi.correction).mockRejectedValueOnce(new Error('连接中断'));
  vi.mocked(creationApi.receipt).mockResolvedValue({ status: 'ready', photo: { ...photo, id: 10, objects: [{ id: 20, label: '杯子' }] } });
  render(<CreateCompanion />);
  fireEvent.click(await screen.findByText('纠正对象或特征'));
  fireEvent.click(await screen.findByText('核对结果'));
  await screen.findByText('这次想和谁交朋友？');
  expect(creationApi.correction).toHaveBeenCalledTimes(1);
  expect(creationApi.upload).not.toHaveBeenCalled();
  expect(generateCompanion).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ photoId: 10 });
});

it('only reports upload-to-image time after the final image loads even while motion is pending', async () => {
  vi.mocked(loadPrivateMotion).mockImplementation(() => new Promise(() => {}));
  vi.mocked(generateCompanion).mockResolvedValue({ ...character, image_path: 'characters/final.png' });
  render(<CreateCompanion />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  await waitFor(() => expect(screen.getByRole('img', { name: '小杯' }).tagName).toBe('IMG'));
  const image = screen.getByAltText('小杯');
  expect(screen.queryByText(/本次从上传到图片显示/)).not.toBeInTheDocument();
  Object.defineProperty(image, 'naturalWidth', { value: 1024 });
  fireEvent.load(image);
  expect(await screen.findByText(/本次从上传到图片显示用时/)).toBeInTheDocument();
});


it('keeps the upload clock running across recognition and generation without replay', async () => {
  let recognized!: (value: typeof photo) => void;
  vi.mocked(creationApi.upload).mockImplementation(() => new Promise(resolve => { recognized = resolve; }));
  vi.mocked(generateCompanion).mockImplementation(() => new Promise(() => {}));
  render(<CreateCompanion />); await selectPhoto();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByText('上传并生成伙伴'));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); recognized(photo); });
    expect(screen.getByText('已等待 6 秒')).toBeInTheDocument();
    expect(screen.getByText('一个小小的相遇，正在发生。')).toBeInTheDocument();
    expect(creationApi.upload).toHaveBeenCalledTimes(1);
    expect(generateCompanion).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});


it('keeps the theme through upload, generation and read-only refresh', async () => {
  const themed = { ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '苹果', category: 'fruit' }] };
  vi.mocked(creationApi.upload).mockResolvedValue(themed);
  vi.mocked(creationApi.photo).mockResolvedValue(themed);
  vi.mocked(generateCompanion).mockResolvedValue({ ...character, theme_id: 'fruit' });
  const view = render(<CreateCompanion initialTheme="fruit" />); await selectPhoto();
  fireEvent.click(screen.getByText('上传并生成伙伴')); await screen.findByText('一份水果 · 已加入我的收藏');
  expect(vi.mocked(creationApi.upload).mock.calls[0][3]).toBe('fruit');
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ themeId: 'fruit', objectId: 2 });
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, theme_id: 'fruit' });
  view.unmount(); render(<CreateCompanion />); await screen.findByText('一份水果 · 已加入我的收藏');
  expect(generateCompanion).toHaveBeenCalledTimes(1);
});

it.each(['object', 'unknown'])('stops a %s subject and persists an explicit free-creation choice', async category => {
  const themed = { ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '杯子', category }] };
  vi.mocked(creationApi.upload).mockResolvedValue(themed); vi.mocked(creationApi.photo).mockResolvedValue(themed);
  const view = render(<CreateCompanion initialTheme="fruit" />); await selectPhoto();
  fireEvent.click(screen.getByText('上传并生成伙伴'));
  await screen.findByText(/还不能确认这个对象符合水果主题/);
  expect(generateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('改为自由创作'));
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ themeId: 'fruit', freeCreation: true });
  view.unmount(); render(<CreateCompanion initialTheme="fruit" />);
  fireEvent.click(await screen.findByRole('button', { name: '杯子' }));
  fireEvent.click(screen.getByRole('button', { name: '生成伙伴' }));
  await screen.findByText('自由创作 · 已加入我的收藏');
  expect(vi.mocked(generateCompanion).mock.calls[0][5]).toBe(true);
  expect(creationApi.upload).toHaveBeenCalledTimes(1);
});

it('can select a different recognized fruit without another upload', async () => {
  vi.mocked(creationApi.upload).mockResolvedValue({ ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '杯子', category: 'object' }, { id: 3, label: '橘子', category: 'fruit' }] });
  render(<CreateCompanion initialTheme="fruit" />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  fireEvent.click(await screen.findByRole('button', { name: '橘子' })); fireEvent.click(screen.getByRole('button', { name: '生成伙伴' }));
  await screen.findByText('已加入我的伙伴'); expect(vi.mocked(generateCompanion).mock.calls[0][0]).toBe(3);
  expect(creationApi.upload).toHaveBeenCalledTimes(1);
});

it('returns an explicit server theme refusal to choices rather than uncertain recovery', async () => {
  vi.mocked(creationApi.upload).mockResolvedValue({ ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '苹果', category: 'fruit' }] });
  vi.mocked(generateCompanion).mockRejectedValue(new ApiError('主题不符', 409, 'theme_mismatch'));
  render(<CreateCompanion initialTheme="fruit" />); await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  await screen.findByRole('button', { name: '生成伙伴' }); expect(screen.queryByText('核对结果')).not.toBeInTheDocument();
  expect(screen.getByText('改为自由创作')).toBeEnabled();
});

it('blocks an unknown URL theme until the user explicitly chooses free creation', async () => {
  render(<CreateCompanion initialTheme="missing" />); await selectPhoto();
  expect(screen.getByText('上传并生成伙伴')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '自由创作' }));
  expect(screen.getByText('上传并生成伙伴')).toBeEnabled();
});

it('offers an offline one-click simulation and sends the built-in file only once', async () => {
  vi.stubEnv('NEXT_PUBLIC_OFFLINE_PREVIEW', 'true');
  vi.mocked(creationApi.upload).mockResolvedValue({ ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '苹果', category: 'fruit' }] });
  vi.mocked(generateCompanion).mockResolvedValue({ ...character, theme_id: 'fruit' });
  try {
    render(<CreateCompanion initialTheme="fruit" />);
    const button = await screen.findByRole('button', { name: '模拟生成伙伴' });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('一份水果 · 已加入我的收藏');
    expect(creationApi.upload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(creationApi.upload).mock.calls[0][0]).toMatchObject({ name: '模拟示意图.png', type: 'image/png' });
    expect(vi.mocked(creationApi.upload).mock.calls[0][3]).toBe('fruit');
    expect(generateCompanion).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllEnvs(); }
});

it('does not expose simulation controls in the main build', async () => {
  vi.stubEnv('NEXT_PUBLIC_OFFLINE_PREVIEW', 'false');
  try {
    render(<CreateCompanion />); await screen.findByLabelText('选择照片');
    expect(screen.queryByRole('button', { name: '模拟生成伙伴' })).not.toBeInTheDocument();
  } finally { vi.unstubAllEnvs(); }
});

it('keeps a restored non-fruit generation disabled with adjacent guidance until explicitly switched', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, label: '杯子', themeId: 'fruit' }));
  vi.mocked(creationApi.photo).mockResolvedValue({ ...photo, theme_id: 'fruit', objects: [{ id: 2, label: '杯子', category: 'object' }] });
  render(<CreateCompanion initialTheme="fruit" />);
  const button = await screen.findByRole('button', { name: '生成伙伴' });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription(/请选择水果对象/);
  fireEvent.click(button); expect(generateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '改为自由创作' }));
  expect(button).toBeEnabled(); fireEvent.click(button);
  await screen.findByText('自由创作 · 已加入我的收藏');
});
it('restores the original team instead of a different route source, without regenerating', async () => {
  const teamId = '22222222-2222-4222-8222-222222222222';
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, themeId: 'fruit', origin: { kind: 'team', theme: 'fruit', teamId } }));
  vi.mocked(creationApi.photo).mockResolvedValue({ ...photo, theme_id: 'fruit' });
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, theme_id: 'fruit' });
  render(<CreateCompanion initialTheme="fruit" initialOrigin={{ kind: 'theme', theme: 'fruit' }} />);
  expect(await screen.findByRole('link', { name: '回到小队，预览提交' })).toHaveAttribute('href', `/teams/${teamId}?resume=1&preview=9`);
  expect(generateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '再认识一个伙伴' }));
  expect(screen.getByRole('link', { name: '返回小队' })).toHaveAttribute('href', `/teams/${teamId}?resume=1`);
});
it('keeps a free-creation result private and returns without a submission preview', async () => {
  render(<CreateCompanion initialOrigin={{ kind: 'theme', theme: 'fruit' }} />);
  await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  expect(await screen.findByRole('link', { name: '回到原主题' })).toHaveAttribute('href', '/themes/fruit?resume=1');
  expect(screen.getByText(/这位伙伴属于自由创作/)).toBeVisible();
});

it('drops an inaccessible draft source and restores the current entry without generating', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, themeId: 'fruit', origin: { kind: 'team', theme: 'fruit', teamId: '22222222-2222-4222-8222-222222222222' } }));
  vi.mocked(creationApi.photo).mockRejectedValue(new ApiError('没有找到', 404, 'not_found'));
  render(<CreateCompanion />);
  await screen.findByText('没有找到可恢复的记录，请重新选择照片。');
  expect(screen.queryByRole('link', { name: '返回小队' })).not.toBeInTheDocument();
  await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  await screen.findByText('已加入我的伙伴');
  expect(vi.mocked(creationApi.upload).mock.calls[0][3]).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).origin).toBeNull();
});

it('can explicitly start the current theme after recovering a finished free creation', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  vi.mocked(creationApi.byObject).mockResolvedValue(character);
  render(<CreateCompanion initialTheme="fruit" initialOrigin={{ kind: 'theme', theme: 'fruit' }} />);
  const restart = await screen.findByRole('button', { name: '按当前入口开始新创作' });
  expect(generateCompanion).not.toHaveBeenCalled();
  fireEvent.click(restart);
  expect(screen.getByRole('link', { name: '返回主题作品墙' })).toHaveAttribute('href', '/themes/fruit?resume=1');
  expect(generateCompanion).not.toHaveBeenCalled();
  await selectPhoto(); fireEvent.click(screen.getByText('上传并生成伙伴'));
  await screen.findByText('已加入我的伙伴');
  expect(vi.mocked(creationApi.upload).mock.calls[0][3]).toBe('fruit');
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).origin).toEqual({ kind: 'theme', theme: 'fruit' });
});
it('does not offer a new-entry restart while an old generation is unresolved', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, status: 'generating' });
  render(<CreateCompanion initialTheme="fruit" initialOrigin={{ kind: 'theme', theme: 'fruit' }} />);
  await screen.findByText(/伙伴仍在生成中/);
  expect(screen.queryByRole('button', { name: '按当前入口开始新创作' })).not.toBeInTheDocument();
  expect(generateCompanion).not.toHaveBeenCalled();
});
it('records one diagnostic across upload, generation and displayed image, not ready text alone', async()=>{
  vi.stubEnv('NEXT_PUBLIC_GENERATION_DIAGNOSTICS','true');
  try{
    vi.mocked(generateCompanion).mockResolvedValue({...character,image_path:'characters/test.png'});
    render(<CreateCompanion/>);await selectPhoto();fireEvent.click(screen.getByText('上传并生成伙伴'));
    await screen.findByText('已加入我的伙伴');
    const read=()=>JSON.parse(sessionStorage.getItem('companion-generation-performance-v1')!);
    expect(read().samples).toHaveLength(1);expect(read().samples[0].status).toBe('running');
    const img=await screen.findByAltText('小杯');Object.defineProperty(img,'naturalWidth',{value:96});
    fireEvent.load(img);await waitFor(()=>expect(read().samples[0].status).toBe('succeeded'));
    expect(Object.keys(read().samples[0].marks)).toEqual(expect.arrayContaining(['click','upload_started','recognized','generation_started','ready','displayed','ended']));
    expect(creationApi.upload).toHaveBeenCalledTimes(1);expect(generateCompanion).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllEnvs();}
});
it('keeps an interrupted diagnostic when leaving during recognition and does not resume its clock',async()=>{
  vi.stubEnv('NEXT_PUBLIC_GENERATION_DIAGNOSTICS','true');
  try{
    vi.mocked(creationApi.upload).mockImplementation(()=>new Promise(()=>{}));
    const view=render(<CreateCompanion/>);await selectPhoto();fireEvent.click(screen.getByText('上传并生成伙伴'));
    await waitFor(()=>expect(creationApi.upload).toHaveBeenCalledTimes(1));view.unmount();
    const stored=JSON.parse(sessionStorage.getItem('companion-generation-performance-v1')!);
    expect(stored.samples[0].status).toBe('interrupted');expect(stored.samples[0].marks.displayed).toBeUndefined();expect(generateCompanion).not.toHaveBeenCalled();
  }finally{vi.unstubAllEnvs();}
});


it('restores a result without motion and keeps rename and navigation independent of resource loading', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  const saved = { ...character, image_path: 'characters/final.png' };
  vi.mocked(creationApi.byObject).mockResolvedValue(saved);
  vi.mocked(creationApi.rename).mockResolvedValue({ ...saved, name: '小暖' });
  render(<CreateCompanion />);
  await waitFor(() => expect(screen.getByRole('img', { name: '小杯' }).tagName).toBe('IMG'));
  fireEvent.load(screen.getByAltText('小杯'));
  // Ready walk is auto-selected; without an asset the player keeps the static portrait.
  expect(await screen.findByText('这类动作还没准备好，先看看静态形象')).toBeInTheDocument();
  expect(await screen.findByText('已就绪')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '散步' })).toHaveAttribute('aria-pressed', 'true');
  expect(readMotionPreparation).toHaveBeenCalledWith(9, expect.any(String), expect.any(AbortSignal));
  expect(loadPreparedActivityMotion).toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('给伙伴一个喜欢的名字'), { target: { value: '小暖' } });
  fireEvent.click(screen.getByText('保存名字'));
  await screen.findByText('名字已保存');
  expect(screen.getByRole('img', { name: '小暖' })).toBeInTheDocument();
  expect(privateImageBlob).toHaveBeenCalled();
  expect(screen.getByText('开始聊天')).toHaveAttribute('href', '/companions/9');
  expect(screen.queryByText(/本次从上传到图片显示/)).not.toBeInTheDocument();
  expect(generateCompanion).not.toHaveBeenCalled();
  expect(creationApi.upload).not.toHaveBeenCalled();
});

it('keeps a saved result accessible after private image fetch failure and recovers only when clicked', async () => {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  vi.mocked(creationApi.byObject).mockResolvedValue({ ...character, image_path: 'characters/final.png' });
  // Keep failing across the walk auto-select remount until the user retries.
  vi.mocked(privateImageBlob).mockRejectedValue(new Error('unavailable'));
  render(<CreateCompanion />);
  expect(await screen.findByText('图片暂时未能加载，请刷新核对，伙伴已保存。')).toBeInTheDocument();
  expect(screen.getByText('开始聊天')).toHaveAttribute('href', '/companions/9');
  expect(await screen.findByText('重新加载动作')).toBeInTheDocument();
  expect(loadPrivateMotion).not.toHaveBeenCalled();
  vi.mocked(privateImageBlob).mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  fireEvent.click(screen.getByText('重新加载动作'));
  await waitFor(() => expect(screen.getByRole('img', { name: '小杯' }).tagName).toBe('IMG'));
  fireEvent.load(screen.getByAltText('小杯'));
  expect(screen.queryByText('图片暂时未能加载，请刷新核对，伙伴已保存。')).not.toBeInTheDocument();
  expect(generateCompanion).not.toHaveBeenCalled();
  expect(creationApi.upload).not.toHaveBeenCalled();
});
