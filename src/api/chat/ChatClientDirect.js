import axios from 'axios'
import * as pako from 'pako'

import { getUuid4Hex } from '@/utils'
import * as avatar from './avatar'

const HEADER_SIZE = 16

// const WS_BODY_PROTOCOL_VERSION_INFLATE = 0
// const WS_BODY_PROTOCOL_VERSION_NORMAL = 1
const WS_BODY_PROTOCOL_VERSION_DEFLATE = 2

// const OP_HANDSHAKE = 0
// const OP_HANDSHAKE_REPLY = 1
const OP_HEARTBEAT = 2
const OP_HEARTBEAT_REPLY = 3
// const OP_SEND_MSG = 4
const OP_SEND_MSG_REPLY = 5
// const OP_DISCONNECT_REPLY = 6
const OP_AUTH = 7
const OP_AUTH_REPLY = 8
// const OP_RAW = 9
// const OP_PROTO_READY = 10
// const OP_PROTO_FINISH = 11
// const OP_CHANGE_ROOM = 12
// const OP_CHANGE_ROOM_REPLY = 13
// const OP_REGISTER = 14
// const OP_REGISTER_REPLY = 15
// const OP_UNREGISTER = 16
// const OP_UNREGISTER_REPLY = 17
// B站业务自定义OP
// const MinBusinessOp = 1000
// const MaxBusinessOp = 10000

const HEARTBEAT_INTERVAL = 10 * 1000
const RECEIVE_TIMEOUT = HEARTBEAT_INTERVAL + 5 * 1000

let textEncoder = new TextEncoder()
let textDecoder = new TextDecoder()

export default class ChatClientDirect {
  constructor(roomId) {
    // 调用initRoom后初始化，如果失败，使用这里的默认值
    this.roomId = roomId
    this.roomOwnerUid = 0
    this.hostServerList = [
      { host: "broadcastlv.chat.bilibili.com", port: 2243, wss_port: 443, ws_port: 2244 }
    ]
    this.hostRooms = [
      7531054,
      23094410,
      21533891,
      23140417,
      4820656,
      23187876
    ]

    this.onAddText = null
    this.onAddGift = null
    this.onAddMember = null
    this.onAddSuperChat = null
    this.onDelSuperChat = null
    this.onUpdateTranslation = null

    //this.websocket = null
    this.websocketList = []
    this.retryCount = 0
    this.isDestroying = false
    this.heartbeatTimerId = null
    //this.receiveTimeoutTimerId = null
  }

  async start() {
    //await this.initRoom()
    this.hostRooms.forEach(roomIdData => {
      this.wsConnectTo(roomIdData)
    });

    //this.wsConnect()
    this.heartbeatTimerId = window.setInterval(this.sendHeartbeat.bind(this), HEARTBEAT_INTERVAL)
  }

  wsConnectTo(roomIdData) {
    console.log(roomIdData)
    if (this.isDestroying) {
      return
    }
    let hostServer = this.hostServerList[this.retryCount % this.hostServerList.length]
    const url = `wss://${hostServer.host}:${hostServer.wss_port}/sub`
    var websocket = new WebSocket(url)
    var arrayInfo = {
      "roomId": roomIdData,
      "wsConnecion": websocket,
      "receiveTimeoutTimerId": null
    }
    this.websocketList[roomIdData] = arrayInfo;
    websocket.binaryType = 'arraybuffer'
    websocket.onopen = this.onWsOpen.bind(this, roomIdData)
    websocket.onclose = this.onWsClose.bind(this, roomIdData)
    websocket.onmessage = this.onWsMessage.bind(this, roomIdData)
  }

  stop() {
    this.isDestroying = true
    window.clearInterval(this.heartbeatTimerId)

    this.websocketList.forEach(wsServerArray => {
      wsServerArray.wsConnecion.close()
    })
  }

  async initRoom() {
    let res
    try {
      res = (await axios.get('/api/room_info', {
        params: {
          roomId: this.roomId
        }
      })).data
    } catch {
      return
    }
    this.roomId = res.roomId
    this.roomOwnerUid = res.ownerUid
    if (res.hostServerList.length !== 0) {
      this.hostServerList = res.hostServerList
    }
  }

  makePacket(data, operation) {
    let body = textEncoder.encode(JSON.stringify(data))
    let header = new ArrayBuffer(HEADER_SIZE)
    let headerView = new DataView(header)
    headerView.setUint32(0, HEADER_SIZE + body.byteLength)   // pack_len
    headerView.setUint16(4, HEADER_SIZE)                     // raw_header_size
    headerView.setUint16(6, 1)                               // ver
    headerView.setUint32(8, operation)                       // operation
    headerView.setUint32(12, 1)                              // seq_id
    return new Blob([header, body])
  }

  sendAuth(roomIdData) {
    let authParams = {
      uid: 0,
      roomid: roomIdData,
      protover: 2,
      platform: 'web',
      clientver: '1.14.3',
      type: 2
    }
    if (this.websocketList[roomIdData] != null) {
      this.websocketList[roomIdData].wsConnecion.send(this.makePacket(authParams, OP_AUTH))
      console.log(`Sended Auth ${roomIdData}`)
    }
  }

  onWsOpen(roomIdData) {
    console.log(roomIdData)
    this.sendAuth(roomIdData)
    this.refreshReceiveTimeoutTimer(roomIdData)
  }

  sendHeartbeat() {
    this.websocketList.forEach(wsArray => {
      if (wsArray.wsConnecion != null) {
        if (wsArray.wsConnecion.readyState == 1) {
          window.console.log(`${wsArray.roomId} 发送心跳`)
          wsArray.wsConnecion.send(this.makePacket({}, OP_HEARTBEAT))
        }
      }
    })
  }

  refreshReceiveTimeoutTimer(roomIdData) {
    var data = this.websocketList[roomIdData]
    if (data != null) {
      if (data.receiveTimeoutTimerId) {
        window.clearTimeout(data.receiveTimeoutTimerId)
      }
      data.receiveTimeoutTimerId = window.setTimeout(this.onReceiveTimeout.bind(this, roomIdData), RECEIVE_TIMEOUT)
    }
  }

  onReceiveTimeout(roomIdData) {
    window.console.warn(`${roomIdData} 接收消息超时`)
    var data = this.websocketList[roomIdData]
    if (data != null) {
      data.receiveTimeoutTimerId = null
      data.wsConnecion.onopen = data.wsConnecion.onclose = data.wsConnecion.onmessage = null
      data.wsConnecion.close()
      this.onWsClose(roomIdData)
    }
    // 直接丢弃阻塞的websocket，不等onclose回调了
  }

  onWsClose(roomIdData) {
    var data = this.websocketList[roomIdData]
    if (data != null) {
      data.wsConnecion = null
      if (data.receiveTimeoutTimerId) {
        window.clearTimeout(data.receiveTimeoutTimerId)
        data.receiveTimeoutTimerId = null
      }
    }
    if (this.isDestroying) {
      return
    }
    window.console.warn(`${roomIdData} 掉线重连中 ${++this.retryCount}`)
    window.setTimeout(this.wsConnectTo.bind(this, roomIdData), 1000)
  }

  onWsMessage(roomIdData, event) {
    window.console.log(`${roomIdData} 接收到消息`)
    this.refreshReceiveTimeoutTimer(roomIdData)
    this.retryCount = 0
    if (!(event.data instanceof ArrayBuffer)) {
      window.console.warn('未知的websocket消息：', event.data)
      return
    }

    let data = new Uint8Array(event.data)
    window.console.log(`${roomIdData} 消息内容（${data.byteLength}） ${data}`)
    if (data.byteLength > 22) {
      this.handlerMessage(data)
    }
  }

  handlerMessage(data) {
    let offset = 0
    while (offset < data.byteLength) {
      let dataView = new DataView(data.buffer, offset)
      let packLen = dataView.getUint32(0)
      // let rawHeaderSize = dataView.getUint16(4)
      let ver = dataView.getUint16(6)
      let operation = dataView.getUint32(8)
      // let seqId = dataView.getUint32(12)

      switch (operation) {
        case OP_HEARTBEAT_REPLY: {
          // 人气值没用
          break
        }
        case OP_SEND_MSG_REPLY: {
          let body = new Uint8Array(data.buffer, offset + HEADER_SIZE, packLen - HEADER_SIZE)
          if (ver == WS_BODY_PROTOCOL_VERSION_DEFLATE) {
            body = pako.inflate(body)
            this.handlerMessage(body)
          } else {
            try {
              body = JSON.parse(textDecoder.decode(body))
              this.handlerCommand(body)
            } catch (e) {
              window.console.warn('body:', body)
              throw e
            }
          }
          break
        }
        case OP_AUTH_REPLY: {
          this.sendHeartbeat()
          break
        }
        default: {
          let body = new Uint8Array(data.buffer, offset + HEADER_SIZE, packLen - HEADER_SIZE)
          window.console.warn('未知包类型：operation=', operation, body)
          break
        }
      }

      offset += packLen
    }
  }

  handlerCommand(command) {
    if (command instanceof Array) {
      for (let oneCommand of command) {
        this.handlerCommand(oneCommand)
      }
      return
    }

    let cmd = command.cmd || ''
    let pos = cmd.indexOf(':')
    if (pos != -1) {
      cmd = cmd.substr(0, pos)
    }
    let handler = COMMAND_HANDLERS[cmd]
    if (handler) {
      handler.call(this, command)
    }
  }

  async onReceiveDanmaku(command) {
    if (!this.onAddText) {
      return
    }
    let info = command.info

    let roomId, medalLevel
    if (info[3]) {
      roomId = info[3][3]
      medalLevel = info[3][0]
    } else {
      roomId = medalLevel = 0
    }

    let uid = info[2][0]
    let isAdmin = info[2][2]
    let privilegeType = info[7]
    let authorType
    if (uid === this.roomOwnerUid) {
      authorType = 3
    } else if (isAdmin) {
      authorType = 2
    } else if (privilegeType !== 0) {
      authorType = 1
    } else {
      authorType = 0
    }

    let urank = info[2][5]
    let data = {
      avatarUrl: await avatar.getAvatarUrl(uid),
      timestamp: info[0][4] / 1000,
      authorName: info[2][1],
      authorType: authorType,
      content: info[1],
      privilegeType: privilegeType,
      isGiftDanmaku: !!info[0][9],
      authorLevel: info[4][0],
      isNewbie: urank < 10000,
      isMobileVerified: !!info[2][6],
      medalLevel: roomId === this.roomId ? medalLevel : 0,
      id: getUuid4Hex(),
      translation: ''
    }
    this.onAddText(data)
  }

  onReceiveGift(command) {
    if (!this.onAddGift) {
      return
    }
    let data = command.data
    if (data.coin_type !== 'gold') { // 丢人
      return
    }

    data = {
      id: getUuid4Hex(),
      avatarUrl: avatar.processAvatarUrl(data.face),
      timestamp: data.timestamp,
      authorName: data.uname,
      totalCoin: data.total_coin,
      giftName: data.giftName,
      num: data.num
    }
    this.onAddGift(data)
  }

  async onBuyGuard(command) {
    if (!this.onAddMember) {
      return
    }

    let data = command.data
    data = {
      id: getUuid4Hex(),
      avatarUrl: await avatar.getAvatarUrl(data.uid),
      timestamp: data.start_time,
      authorName: data.username,
      privilegeType: data.guard_level
    }
    this.onAddMember(data)
  }

  onSuperChat(command) {
    if (!this.onAddSuperChat) {
      return
    }

    let data = command.data
    data = {
      id: data.id.toString(),
      avatarUrl: avatar.processAvatarUrl(data.user_info.face),
      timestamp: data.start_time,
      authorName: data.user_info.uname,
      price: data.price,
      content: data.message,
      translation: ''
    }
    this.onAddSuperChat(data)
  }

  onSuperChatDelete(command) {
    if (!this.onDelSuperChat) {
      return
    }

    let ids = []
    for (let id of command.data.ids) {
      ids.push(id.toString())
    }
    this.onDelSuperChat({ ids })
  }
}

const COMMAND_HANDLERS = {
  DANMU_MSG: ChatClientDirect.prototype.onReceiveDanmaku,
  SEND_GIFT: ChatClientDirect.prototype.onReceiveGift,
  GUARD_BUY: ChatClientDirect.prototype.onBuyGuard,
  SUPER_CHAT_MESSAGE: ChatClientDirect.prototype.onSuperChat,
  SUPER_CHAT_MESSAGE_DELETE: ChatClientDirect.prototype.onSuperChatDelete
}
