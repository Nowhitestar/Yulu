"""
简单高效的回声消除方案：半双工切换 + 音量归一化。

原理：
- 扬声器（BlackHole）有声音 → 麦克风有回声 → 只取扬声器
- 扬声器（BlackHole）无声 → 麦克风录到人声 → 只取麦克风
- 两者音量归一化到同一级别

优点：O(n) 线性时间，再长的录音也是秒级完成。
"""

import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path):
    with wave.open(str(path), 'rb') as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return sr, samples


def write_wav(path, sr, samples):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((samples * 32767).astype(np.int16).tobytes())


def rms_energy(x):
    """计算 RMS 能量 (dB)。"""
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-10)


def normalize_to_target(x, target_rms_db=-20):
    """将信号 RMS 归一化到目标电平。"""
    current_db = rms_energy(x)
    gain = 10 ** ((target_rms_db - current_db) / 20)
    return np.clip(x * gain, -0.99, 0.99)


def echo_cancel(sys_path, mic_path, output_path, frame_ms=30):
    """
    半双工回声消除 + 音量归一化。
    
    策略：逐帧分析系统音频能量，决定当前帧用哪个源。
    - frame_ms: 分析帧长（毫秒），默认 30ms
    """
    sr, sys_audio = read_wav(sys_path)
    sr2, mic_audio = read_wav(mic_path)
    
    if sr != sr2:
        sr = min(sr, sr2)
    
    min_len = min(len(sys_audio), len(mic_audio))
    sys_audio = sys_audio[:min_len]
    mic_audio = mic_audio[:min_len]
    
    # 帧参数
    frame_size = int(sr * frame_ms / 1000)
    n_frames = min_len // frame_size
    
    # 音量归一化到同一目标
    print("🎚️ 音量归一化...")
    sys_norm = normalize_to_target(sys_audio, -20)
    mic_norm = normalize_to_target(mic_audio, -20)
    
    # 分析系统音频每个帧的能量
    output = np.zeros(min_len, dtype=np.float32)
    sys_threshold = -35  # dB，低于此认为系统无声
    
    print(f"🔇 半双工切换 (帧长={frame_ms}ms, 阈值={sys_threshold}dB)...")
    sys_frames = 0
    mic_frames = 0
    
    for i in range(n_frames):
        start = i * frame_size
        end = start + frame_size
        sys_frame = sys_norm[start:end]
        
        # 检测系统音频是否有声
        sys_db = rms_energy(sys_frame)
        
        if sys_db > sys_threshold:
            # 系统有声音 → 取系统音频（麦克风此时有回声）
            output[start:end] = sys_frame
            sys_frames += 1
        else:
            # 系统无声 → 取麦克风（此时只有人声）
            output[start:end] = mic_norm[start:end]
            mic_frames += 1
    
    # 对切换点做交叉淡入淡出，避免咔嗒声
    fade_len = min(frame_size // 4, 512)
    for i in range(1, n_frames):
        prev_start = (i - 1) * frame_size
        prev_end = prev_start + frame_size
        curr_start = i * frame_size
        curr_end = curr_start + frame_size
        
        # 判断前后帧来源是否不同
        prev_sys = rms_energy(sys_norm[prev_start:prev_end]) > sys_threshold
        curr_sys = rms_energy(sys_norm[curr_start:curr_end]) > sys_threshold
        
        if prev_sys != curr_sys:
            # 切换点：做交叉淡入淡出
            cross_start = curr_start - min(fade_len, frame_size // 2)
            cross_end = curr_start + fade_len
            if cross_start >= 0 and cross_end <= min_len:
                fade_in = np.linspace(0, 1, fade_len)
                fade_out = np.linspace(1, 0, fade_len)
                output[cross_start:cross_start + fade_len] *= fade_out
                output[cross_start:cross_start + fade_len] += output[cross_start:cross_start + fade_len] * fade_in * 0  # keep original
    
    # 最终音量提升 + 限制
    output = np.clip(output * 2.0, -0.99, 0.99)
    
    # 统计
    sys_pct = sys_frames / n_frames * 100
    mic_pct = mic_frames / n_frames * 100
    print(f"📊 组成: 系统音频 {sys_pct:.0f}% | 麦克风 {mic_pct:.0f}%")
    
    write_wav(output_path, sr, output)
    size_mb = Path(output_path).stat().st_size / 1024 / 1024
    print(f"✅ 完成: {output_path} ({size_mb:.1f}MB)")
    return str(output_path)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: echo_cancel.py <sys_audio.wav> <mic_audio.wav> [output.wav]", file=sys.stderr)
        sys.exit(1)
    sys_path = sys.argv[1]
    mic_path = sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) > 3 else \
        str(Path(mic_path).with_suffix(".mic_clean.wav"))
    echo_cancel(sys_path, mic_path, output_path)
