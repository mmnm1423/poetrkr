from flask import Flask, render_template, jsonify, request
import asyncio
import fastapi_poe as fp
import re
import threading
import time
import json

app = Flask(__name__)

# 전역 변수 (단일 세션용)
CURRENT_RESULTS = {}
CURRENT_PROGRESS = {"total": 0, "completed": 0, "messages": [], "response_progress": {}}

# 텍스트를 조각으로 나누는 함수
def split_text(text, max_chars):
    chunks = []
    current_chunk = ""
    lines = text.split('\n')

    for line in lines:
        # 만약 현재 라인을 추가했을 때 최대 글자 수를 초과한다면
        if len(current_chunk) + len(line) + 1 > max_chars and current_chunk:
            chunks.append(current_chunk)
            current_chunk = line + '\n'
        else:
            current_chunk += line + '\n'

    # 마지막 청크 추가
    if current_chunk:
        chunks.append(current_chunk)

    return chunks

# 마크다운 코드 블록 추출 함수
def extract_code_blocks(text):
    pattern = r'```(?:[a-zA-Z]*\n)?([\s\S]*?)```'
    matches = re.findall(pattern, text)
    if matches:
        return '\n'.join(matches)
    return ""

# API 응답 처리 함수 (텍스트 추출)
def extract_text_from_response(response_part):
    # JSON 문자열에서 텍스트 부분 추출
    if isinstance(response_part, str):
        try:
            # JSON으로 파싱 시도
            if response_part.startswith('{') and response_part.endswith('}'):
                json_obj = json.loads(response_part)
                if 'text' in json_obj:
                    return json_obj['text']
        except:
            pass
        return response_part

    # 객체에서 텍스트 속성 추출
    if hasattr(response_part, 'text'):
        return response_part.text

    # 그 외의 경우 문자열로 변환
    return str(response_part)

# 비동기 Poe API 호출 함수
async def call_poe_api(chunk, bot_name, api_key, key_name, chunk_idx):
    try:
        message = fp.ProtocolMessage(role="user", content=chunk)
        result = ""
        char_count = 0

        # 비동기 방식으로 처리
        async for partial in fp.get_bot_response(
            messages=[message], 
            bot_name=bot_name, 
            api_key=api_key
        ):
            # 텍스트 추출
            text_part = extract_text_from_response(partial)
            result += text_part
            char_count += len(text_part)

            # 현재 진행 상황 업데이트
            CURRENT_PROGRESS["response_progress"][chunk_idx] = {
                "chars": char_count,
                "key_name": key_name
            }

        return {"index": chunk_idx, "response": result, "key_name": key_name}
    except Exception as e:
        # 간결한 에러 메시지
        return {"index": chunk_idx, "error": str(e), "key_name": key_name}

# 동기식으로 호출하기 위한 래퍼 함수
def sync_call_poe(chunk, bot_name, api_key, key_name, chunk_idx):
    global CURRENT_RESULTS, CURRENT_PROGRESS

    # 진행 상황 초기화
    CURRENT_PROGRESS["response_progress"][chunk_idx] = {
        "chars": 0,
        "key_name": key_name
    }

    # 동기식 API 호출 시도
    try:
        # 방법 1: get_bot_response_sync 사용 (동기식 API)
        result = ""
        char_count = 0
        message = fp.ProtocolMessage(role="user", content=chunk)

        try:
            for partial in fp.get_bot_response_sync(
                messages=[message], 
                bot_name=bot_name, 
                api_key=api_key
            ):
                # 텍스트 추출
                text_part = extract_text_from_response(partial)
                result += text_part
                char_count += len(text_part)

                # 현재 진행 상황 업데이트
                CURRENT_PROGRESS["response_progress"][chunk_idx] = {
                    "chars": char_count,
                    "key_name": key_name
                }

            CURRENT_RESULTS[chunk_idx] = {"index": chunk_idx, "response": result, "key_name": key_name}
            CURRENT_PROGRESS["completed"] += 1
            CURRENT_PROGRESS["messages"].append(f"{chunk_idx+1}번 조각의 응답을 받았습니다. (API 키: {key_name})")
            return

        except Exception as e:
            # 동기식 호출 실패 시 비동기 방식 시도
            pass

        # 방법 2: 비동기 호출 (get_bot_response 사용)
        async def _call_and_store():
            try:
                result = await call_poe_api(chunk, bot_name, api_key, key_name, chunk_idx)
                CURRENT_RESULTS[chunk_idx] = result
                CURRENT_PROGRESS["completed"] += 1
                CURRENT_PROGRESS["messages"].append(f"{chunk_idx+1}번 조각의 응답을 받았습니다. (API 키: {key_name})")
            except Exception as e:
                CURRENT_PROGRESS["messages"].append(f"{chunk_idx+1}번 조각 처리 중 오류: {str(e)}")
                CURRENT_RESULTS[chunk_idx] = {"index": chunk_idx, "error": str(e), "key_name": key_name}
                CURRENT_PROGRESS["completed"] += 1

        asyncio.run(_call_and_store())

    except Exception as main_e:
        # 간결한 에러 메시지
        CURRENT_PROGRESS["messages"].append(f"{chunk_idx+1}번 조각 처리 중 오류: {str(main_e)}")
        CURRENT_RESULTS[chunk_idx] = {"index": chunk_idx, "error": str(main_e), "key_name": key_name}
        CURRENT_PROGRESS["completed"] += 1

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process', methods=['POST'])
def process():
    global CURRENT_RESULTS, CURRENT_PROGRESS

    # 변수 초기화
    CURRENT_RESULTS = {}
    CURRENT_PROGRESS = {"total": 0, "completed": 0, "messages": [], "response_progress": {}}

    try:
        data = request.json
        text = data['text']
        max_chars = int(data['max_chars'])
        api_keys = data['api_keys']  # [{"name": "키이름", "key": "api키"}, ...]
        selected_key = data['selected_key']
        bot_name = data['bot_name']

        # 텍스트를 조각으로 나누기
        chunks = split_text(text, max_chars)

        # 진행 상황 초기화
        CURRENT_PROGRESS["total"] = len(chunks)
        CURRENT_PROGRESS["messages"].append(f"본문 텍스트를 {len(chunks)}개의 조각으로 나눴습니다.")

        # 시작 키 인덱스 찾기
        start_idx = 0
        for i, key_data in enumerate(api_keys):
            if key_data['name'] == selected_key:
                start_idx = i
                break

        # 사용 가능한 API 키 수 계산
        usable_keys = len(api_keys)
        chunks_to_process = min(len(chunks), usable_keys)

        CURRENT_PROGRESS["messages"].append(
            f"{api_keys[start_idx]['name']}부터 총 {chunks_to_process}개의 조각을 요청합니다."
        )

        # 스레드 목록
        threads = []

        # API 키 인덱스 계산 및 API 호출
        for i in range(chunks_to_process):
            chunk_idx = i
            api_key_idx = (start_idx + i) % len(api_keys)
            api_key_data = api_keys[api_key_idx]
            api_key = api_key_data['key']
            key_name = api_key_data['name']

            CURRENT_PROGRESS["messages"].append(
                f"{key_name} API 키로 {chunk_idx+1}번 조각을 보냈습니다."
            )

            # 스레드 생성 및 시작
            t = threading.Thread(
                target=sync_call_poe,
                args=(chunks[chunk_idx], bot_name, api_key, key_name, chunk_idx)
            )
            threads.append(t)
            t.start()

            # 1초 대기
            time.sleep(1)

        # 스레드 ID 반환
        return jsonify({"message": "처리 시작됨", "thread_count": len(threads)})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/progress', methods=['GET'])
def get_progress():
    global CURRENT_PROGRESS
    return jsonify(CURRENT_PROGRESS)

@app.route('/results', methods=['GET'])
def get_results():
    global CURRENT_RESULTS
    return jsonify({"results": CURRENT_RESULTS})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)