# 《红心对决》接口契约 v1

## 1. 传输约定

- 单 WebSocket 通道：`ws://host:8080/ws`，消息 JSON `{type, data}`。
- 认证：连接后第一条消息 `{type:"auth", data:{username, password}}`；重连用 `{type:"auth", data:{token}}`。
- 服务端错误统一：`{type:"error", data:{code, message}}`。
- 所有状态变更由服务端广播，客户端消息仅为请求。

## 2. 数据模型

```
CardDTO   {id, suit: "spade|heart|club|diamond|joker", rank, power, points}
          // power/points 由服务端按规则 V8.3 计算；points: 5→5, 10→10, K→10, 其余 0
SeatDTO   {seatId, userId, nickname, ready, connected, isDealer, team, handCount}
RoomDTO   {roomId, phase, hostSeatId, seats[4]}
TrickDTO  {trickId, leaderSeat, dimension, cards:[{seatId, cardIds[]}], winnerSeat?}
GameDTO   {dealId, roundNo, dealerSeat, phase, myHand, seats, bottom?, trick?}
```

## 3. 客户端 → 服务端

| type | 说明 |
| --- | --- |
| auth | 登录 / 重连鉴权 |
| create_room | 创建房间 |
| join_room | {roomId} 加入房间 |
| leave_room | 离开（仅房间阶段） |
| ready | {ready: true/false} |
| start_game | 房主开始游戏 |
| reveal_choice | {cardIds?: [...]} 亮三五反，空数组=不亮 |
| tribute_choice | {giveCardId, takeCardId?} 进贡/退贡选择 |
| bury_choice | {cardIds: [6张]} 庄家埋底 |
| play | {cardIds: [...]} 出牌（按维度，1张/多张/4张） |

## 4. 服务端 → 客户端

| type | 说明 |
| --- | --- |
| auth_ok | {token, user} |
| room_updated | 房间状态广播 |
| game_started | 进入游戏 |
| deal | 发牌（含自己手牌） |
| phase_changed | reveal / tribute / bury / trick / round_end |
| trick_updated | 本墩出牌与裁决结果 |
| round_end | 结算数据（双方得分、换庄/进贡、下一庄家） |
| reconnect_snapshot | 重连全量快照（GameDTO） |
| room_dissolved | 房间解散 |
| error | {code, message} |

## 5. 关键约定

1. 任何响应不得包含他方手牌，只允许 handCount 与公开信息（亮出的牌、已出牌、底牌）。
2. `play` 由服务端校验：轮次、手牌归属、维度合法、跟牌规则；非法返回 error 且不广播。
3. 进贡牌由服务端自动判定"最大牌"；退贡校验"任意主牌"（无主牌兜底）；埋底校验 6 张且公开、无分（超分兜底）。
4. 甩牌合法性（花色甩/主牌甩前N张）由服务端判定，前端只做提示。
5. 消息带 seq（客户端自增），服务端可回执去重（简单实现可省略）。

## 6. 示例

```
C→S: {"type":"play","data":{"cardIds":["c12","c15"]}}
S→C(全房): {"type":"trick_updated","data":{...}}
S→C(违规): {"type":"error","data":{"code":"ILLEGAL_PLAY","message":"必须跟红桃"}}
```