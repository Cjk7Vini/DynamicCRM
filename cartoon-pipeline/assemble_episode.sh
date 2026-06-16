#!/usr/bin/env bash
#
# Pip & Bruno - "Lunchpauze" (pilot) | episode assembler
# -----------------------------------------------------
# Downloads the 14 generated shots + music bed + 6 SFX from the Higgsfield CDN
# and renders ONE finished MP4 (shots concatenated, music underneath, SFX synced
# to the gag moments).
#
# REQUIREMENT: the CDN host below must be reachable. On Claude Code on the web set
#   Network access = Full  (claude.ai/code -> cloud icon -> gear -> Network access)
# and run this in a NEW session (the setting only applies to new sessions).
#
# Usage:   bash cartoon-pipeline/assemble_episode.sh
# Output:  ./pip_bruno_lunchpauze.mp4
#
set -euo pipefail

CDN="https://d8j0ntlcm91z4.cloudfront.net/user_3FDIROPxFVhbmMWyy2uYZ52INfC"
WORK="${WORK:-/tmp/pipbruno}"
OUT="${OUT:-$PWD/pip_bruno_lunchpauze.mp4}"
mkdir -p "$WORK/shots" "$WORK/audio"

# --- locate ffmpeg (fetch a static build via pip if missing) ---
FFMPEG="$(command -v ffmpeg || true)"
if [ -z "$FFMPEG" ]; then
  (pip install -q imageio-ffmpeg || pip3 install -q imageio-ffmpeg) >/dev/null 2>&1 || true
  FFMPEG="$(python3 -c 'import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null || true)"
fi
[ -z "$FFMPEG" ] && { echo "ERROR: ffmpeg not available"; exit 1; }
echo "ffmpeg: $FFMPEG"

# --- 14 shots, in story order ---
SHOTS=(
  "hf_20260616_143436_14ebc179-ecdc-4530-aace-c66a8dd63354.mp4"  # 1  Pip enters with sandwich
  "hf_20260616_143438_fd5b1915-4954-49ce-81da-f4bb82c3d06a.mp4"  # 2  Pip takes a blissful bite
  "hf_20260616_143439_c96cb3f4-2cfb-4a13-8d87-dcb68e2fc1ce.mp4"  # 3  Bruno spots the sandwich
  "hf_20260616_143441_a78f63ff-6820-4474-adc4-13a928cb7c3e.mp4"  # 4  Bruno tiptoes with mallet
  "hf_20260616_143443_40304e38-715a-44fa-bb9a-d3751eb7b655.mp4"  # 5  Mallet smashes empty crate
  "hf_20260616_143445_ad451831-515f-44e8-8cfc-325adbfdc728.mp4"  # 6  Bruno's throbbing foot
  "hf_20260616_143808_e5890ce1-e319-4023-b26a-c254aab7c3aa.mp4"  # 7  Bruno sets a trap
  "hf_20260616_143811_8663f46f-7e19-4439-8487-7929fa2aa586.mp4"  # 8  Bruno steps in own snare
  "hf_20260616_143813_be81bd37-f9b5-4672-8dfb-d58b8b171958.mp4"  # 9  Crate slams onto Bruno
  "hf_20260616_143816_7c2e266e-4ae2-4f7a-91eb-8c92c173ce90.mp4"  # 10 Bruno loads catapult
  "hf_20260616_143817_0bf66a7a-99e8-471b-b415-7bf91808cb04.mp4"  # 11 Catapult flings Bruno
  "hf_20260616_143820_6515a745-46bf-4000-9f8b-b789416ac084.mp4"  # 12 Bruno smacks the fence
  "hf_20260616_144035_2ce8fb03-c992-4fbf-a372-8f023ea413a6.mp4"  # 13 Pip offers half
  "hf_20260616_144058_8ee2975a-3999-4243-a5ca-d2ee6893fc69.mp4"  # 14 Friends + iris-out
)

MUSIC="hf_20260616_143559_7bd57361-ae76-4f85-9295-6c1e81bb88ae.m4a"

# SFX entries: "file|delay_ms|volume"  (each shot is 5s; delay = position in the 70s timeline)
SFX=(
  "hf_20260616_151911_049d4c02-dd12-45b2-9705-4739b1324674.mp3|15500|1.0"  # tiptoe   (shot 4)
  "hf_20260616_151911_46abd1bc-a3f1-4943-8cb7-426d2fb8d197.mp3|21200|1.3"  # WHACK    (shot 5)
  "hf_20260616_151913_09e4a452-08b9-4946-bd66-6140c93a5654.mp3|25500|1.1"  # pain     (shot 6)
  "hf_20260616_151915_a34f8719-9152-43a6-bcdb-605467d42cb8.mp3|40500|1.3"  # SLAM     (shot 9)
  "hf_20260616_151916_f7eae84d-2ced-4b74-b3f4-ee03d89c6c52.mp3|50800|1.2"  # launch   (shot 11)
  "hf_20260616_151917_e1cb3008-28c2-476b-9509-0ae232f3818e.mp3|55300|1.3"  # crash    (shot 12)
)

dl () { # url dest
  curl -fsSL "$1" -o "$2" || {
    echo "ERROR downloading: $1"
    echo "-> Is the CDN host allowlisted? Set Network access = Full and run in a NEW session."
    exit 2
  }
}

echo "Downloading 14 shots..."
VID_INPUTS=()
i=0
for s in "${SHOTS[@]}"; do
  i=$((i+1)); f="$WORK/shots/$(printf '%02d' "$i").mp4"
  dl "$CDN/$s" "$f"
  VID_INPUTS+=( -i "$f" )
done

echo "Downloading music + SFX..."
dl "$CDN/$MUSIC" "$WORK/audio/music.m4a"
n=0
for e in "${SFX[@]}"; do
  n=$((n+1)); dl "$CDN/${e%%|*}" "$WORK/audio/sfx$n.mp3"
done

# --- Pass 1: concat the 14 silent shots (normalised to 1920x1080 / 30fps) ---
echo "Concatenating shots..."
VF=""
for k in $(seq 0 13); do
  VF="$VF[$k:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,fps=30,format=yuv420p[v$k];"
done
for k in $(seq 0 13); do VF="$VF[v$k]"; done
VF="${VF}concat=n=14:v=1:a=0[v]"
"$FFMPEG" -y "${VID_INPUTS[@]}" -filter_complex "$VF" \
  -map "[v]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -an "$WORK/silent.mp4"

# --- Pass 2: music bed + timed SFX, then mux onto the video ---
echo "Mixing audio + muxing..."
AUD_INPUTS=( -i "$WORK/silent.mp4" -i "$WORK/audio/music.m4a" )
AF="[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.55[m];"
LABELS="[m]"
idx=2
for e in "${SFX[@]}"; do
  rest="${e#*|}"; delay="${rest%%|*}"; vol="${rest##*|}"
  AUD_INPUTS+=( -i "$WORK/audio/sfx$((idx-1)).mp3" )
  AF="$AF[$idx:a]aresample=48000,aformat=channel_layouts=stereo,volume=$vol,adelay=${delay}:all=1[e$idx];"
  LABELS="$LABELS[e$idx]"
  idx=$((idx+1))
done
TOTAL=$((idx-1))   # music + sfx count
AF="${AF}${LABELS}amix=inputs=${TOTAL}:normalize=0:duration=longest[a]"

"$FFMPEG" -y "${AUD_INPUTS[@]}" -filter_complex "$AF" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "$OUT"

echo ""
echo "DONE -> $OUT"
