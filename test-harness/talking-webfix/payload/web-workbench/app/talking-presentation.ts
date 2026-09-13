// UI descriptions follow the prepared job, rather than assuming every preview is 8s.
type PresentationJob = {
  state: string; mode?: string; speech_source?: string; voice_state?: string;
  generation_strategy?: string; is_long?: boolean; final_output?: string;
  output?: string; published_output?: string; voice_output?: string;
  duration?: number; measured_duration?: number; estimated_rh_coins?: number;
  voice_budget_limit?: number;
  sample?: { duration?: number; estimated_rh_coins?: number };
  segments?: Array<{ estimated_rh_coins?: number }>;
};
export function isCompleteTalkingVideo(job?: PresentationJob | null) {
  return Boolean(job && (job.generation_strategy === 'direct_full' ||
    (['completed', 'approved'].includes(job.state) && job.final_output)));
}
export function talkingResultMedia(job: PresentationJob) {
  if (job.state === 'voice_review' && job.voice_output) return 'audio';
  if (['sample_review', 'completed', 'approved'].includes(job.state) && (job.output || job.published_output)) return 'video';
  return null;
}
export function talkingSubmissionPlan(job?: PresentationJob | null) {
  const voice = job?.speech_source === 'clone' && job.voice_state !== 'approved';
  const sample = !voice && job?.is_long && job.generation_strategy !== 'direct_full' && job.sample;
  const currentCoins = voice ? job.voice_budget_limit ?? job.estimated_rh_coins
    : sample ? sample.estimated_rh_coins : job?.estimated_rh_coins;
  return {
    title: voice ? '本次生成 1 条声音' : sample ? '本次先生成 1 条样片' : '本次生成完整内容',
    duration: voice ? null : sample ? sample.duration : job?.measured_duration || job?.duration,
    submissions: voice || sample || !job?.is_long ? 1 : job.segments?.length || 1,
    currentCoins: currentCoins ?? null,
    projectCoins: sample ? job?.estimated_rh_coins ?? null : null,
  };
}
export function talkingSampleChoice(mode: string) {
  return mode === 'standard'
    ? '短音频会整段生成；长音频先做短样片，提交前确认实际时长'
    : '先做短样片；实际时长在提交前确认';
}
export function missingTalkingFileHints(input: {
  mode: string; speechSource: string; nativeVoiceMode: string; nativeDialogueMode: string;
  voiceName: string; speechName: string; hasVoice: boolean; hasSpeech: boolean;
}) {
  const needsVoice = input.mode !== 'native' ? input.speechSource === 'clone'
    : input.nativeDialogueMode === 'single' && input.nativeVoiceMode === 'reference';
  return [
    needsVoice && !input.hasVoice && input.voiceName ? `请重新选择声音参考：${input.voiceName}。` : '',
    input.mode !== 'native' && input.speechSource === 'audio' && !input.hasSpeech && input.speechName
      ? `请重新选择音频：${input.speechName}。` : '',
  ].join('');
}
export function talkingSubmissionSummary(job: PresentationJob) {
  // Old jobs may lack individual remote ids; describe the recorded stages, not a guessed request count.
  const parts = [];
  if (job.speech_source === 'clone' && job.voice_state === 'approved') parts.push('声音已确认');
  if (job.is_long && ['completed', 'approved'].includes(job.state) && job.final_output) {
    if (job.sample) parts.push('样片已确认');
    parts.push(`${job.segments?.length || 0} 个正式片段已合成`);
  } else if (job.is_long && job.sample && ['sample_review', 'sample_running'].includes(job.state)) {
    parts.push('本次为样片');
  } else parts.push(job.is_long ? `${job.segments?.length || 0} 个片段` : '本次为单段视频');
  return parts.join(' · ');
}
