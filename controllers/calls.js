const twilio = require("twilio");
const { VoiceResponse } = require("twilio").twiml;

const { callModel } = require("../models/call");
const { agentModel } = require("../models/agent");
const { StreamService } = require("../services/stream-service");
const { TranscriptionService } = require("../services/transcription-service");
const { TextToSpeechService } = require("../services/tts-service");
const { recordingService } = require("../services/recording-service");
const { getFullISTDateTime, formatISTTime } = require("../utils/dateTime");
const { GptService } = require("../services/gpt-service");

// Global Map to store called_number by callSid
const callSidToCalledNumber = new Map();

// In-memory cache of agents
let agentMap = {};

// Fetch agents from database and populate agentMap
const loadAgents = async () => {
  try {
    const agents = await agentModel.find();
    agentMap = agents.reduce((map, agent) => {
      map[normalizePhoneNumber(agent.twilioNumber)] = agent.name;
      return map;
    }, {});
    console.log(`Loaded agents: ${JSON.stringify(agentMap)}`.cyan);
  } catch (error) {
    console.error(`Error loading agents: ${error.message}`.red);
  }
};

// Normalize phone number by removing spaces, dashes, and ensuring + prefix
const normalizePhoneNumber = (number) => {
  if (!number) return number;
  return '+' + number.replace(/[^0-9]/g, '');
};

// get callModel
const getCall = async (req, res) => {
  try {
    const calls = await callModel.find();
    res.status(200).json(calls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// create callModel
const createCall = async (req, res) => {
  const callObj = new callModel(req.body);
  try {
    const newCall = await callObj.save();
    res.status(201).json(newCall);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// update callModel
const updateCall = async (req, res) => {
  const callObj = await callModel.findById(req.params.id);
  if (!callObj) {
    return res.status(404).json({ message: "callModel not found" });
  }
  try {
    const updatedCall = await callModel.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.status(200).json(updatedCall);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// delete callModel
const deleteCall = async (req, res) => {
  const callObj = await callModel.findById(req.params.id);
  if (!callObj) {
    return res.status(404).json({ message: "callModel not found" });
  }
  try {
    await callModel.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "callModel deleted" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// incoming callModel
const incomingCall = async (req, res) => {
  try {
    console.log(`Incoming call query: ${JSON.stringify(req.query, null, 2)}`.cyan);
    console.log(`Incoming call body: ${JSON.stringify(req.body, null, 2)}`.cyan);

    const isValidAccount1 = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN_1,
      req.headers['x-twilio-signature'],
      `https://${process.env.SERVER}${req.originalUrl}`,
      req.body
    );

    const isValidAccount2 = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN_2,
      req.headers['x-twilio-signature'],
      `https://${process.env.SERVER}${req.originalUrl}`,
      req.body
    );

    if (!isValidAccount1 && !isValidAccount2) {
      console.error('Invalid Twilio signature'.red);
      return res.status(403).send('<Response><Say>Unauthorized request</Say></Response>');
    }

    const response = new VoiceResponse();
    const connect = response.connect();
    const agentType = req.query.agent;
    const calledNumber = req.body && req.body.Called ? normalizePhoneNumber(req.body.Called) : undefined;
    let webhookUrl = `wss://${process.env.SERVER}/call/connection`;
    if (agentType) {
      webhookUrl += `?agent=${agentType}`;
    } else if (calledNumber) {
      webhookUrl += `?called_number=${encodeURIComponent(calledNumber)}`;
    }
    console.log(`Incoming call: Webhook URL = ${webhookUrl}`.cyan);

    const callSid = req.body.CallSid;
    if (calledNumber) {
      callSidToCalledNumber.set(callSid, calledNumber);
      console.log(`Stored called_number ${calledNumber} for callSid ${callSid}`.cyan);
    }

    connect.stream({ 
      url: webhookUrl
    });
    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error(`Error in incomingCall: ${err}`.red);
    res.status(500).send('<Response><Say>Error processing incoming call</Say></Response>');
  }
};

// callModel connection websocket
const callConnection = async (ws, req) => {
  try {
    ws.on("error", (err) => {
      console.error(`WebSocket error: ${err.message}`.red);
    });
    let streamSid;
    let callSid;
    let callStartTime;
    let callEndTime;
    let transcript = [];
    let username = "anonymous";
    let email = "";
    let agentType;
    let initialPrompt = "";
    let isSpeaking = false;
    let errorCount = 0; // Track errors to clear stream if needed

    ws.on("message", async function message(data) {
      try {
        const msg = JSON.parse(data);
        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          callStartTime = new Date();

          if (Object.keys(agentMap).length === 0) {
            await loadAgents();
          }

          console.log(`Full msg: ${JSON.stringify(msg, null, 2)}`.cyan);
          console.log(`msg.start: ${JSON.stringify(msg.start, null, 2)}`.cyan);
          console.log(`Raw req.url: ${req.url}`.cyan);
          console.log(`Raw req.originalUrl: ${req.originalUrl}`.cyan);

          let incomingNumber = callSidToCalledNumber.get(callSid);
          console.log(`Retrieved called_number from callSid ${callSid}: ${incomingNumber || 'undefined'}`.cyan);
          incomingNumber = normalizePhoneNumber(incomingNumber);
          console.log(`Normalized incoming number: ${incomingNumber || 'undefined'}`.cyan);

          agentType = incomingNumber && agentMap[incomingNumber] ? agentMap[incomingNumber] : "booking";
          console.log(`Selected agentType from database: ${agentType}`.cyan);

          if (!agentType || typeof agentType !== "string" || agentType.trim() === "") {
            console.warn(`Invalid agent type: ${agentType}. Defaulting to booking`.yellow);
            agentType = "booking";
          }

          console.log(`Final selected agentType: ${agentType}`.cyan);

          const gptService = new GptService(agentType);
          const streamService = new StreamService(ws);
          const transcriptionService = new TranscriptionService();
          const ttsService = new TextToSpeechService({});

          streamService.setStreamSid(streamSid);
          gptService.setCallSid(callSid);

          let agentDoc = await agentModel.findOne({ name: agentType });
          if (!agentDoc) {
            agentDoc = new agentModel({ name: agentType, prompts: [], twilioNumber: incomingNumber || "+17602786311" });
            await agentDoc.save();
            agentMap[incomingNumber] = agentType;
            console.log(`Created new agent ${agentType} with twilioNumber ${incomingNumber}`.cyan);
          }

          await recordingService(ttsService, callSid).then(() => {
            const initialGreeting = agentType === "booking"
              ? "Hello! I’m here to book your appointment with Inzint. • Are you ready?"
              : "Hi! I’m here to share Inzint’s expert services. • Interested?";
            initialPrompt = initialGreeting;
            console.log(`Initial greeting: ${initialGreeting}`.cyan);
            console.log(
              `Twilio -> Starting Media Stream for ${streamSid} (Agent: ${agentType}) at ${getFullISTDateTime(
                callStartTime
              )}`.underline.red
            );
            ttsService.generate(
              {
                partialResponseIndex: null,
                partialResponse: initialGreeting,
              },
              0
            );
            isSpeaking = true;
          });

          let marks = [];
          let interactionCount = 0;

          ws.on("message", async function message(data) {
            try {
              const msg = JSON.parse(data);
              if (msg.event === "media") {
                transcriptionService.send(msg.media.payload);
              } else if (msg.event === "mark") {
                const label = msg.mark.name;
                console.log(
                  `Twilio -> Audio completed mark (${
                    msg.sequenceNumber
                  }): ${label} at ${formatISTTime(new Date())}`.red
                );
                marks = marks.filter((m) => m !== msg.mark.name);
                isSpeaking = false;
              } else if (msg.event === "stop") {
                callEndTime = new Date();
                console.log(
                  `Twilio -> Media stream ${streamSid} ended at ${getFullISTDateTime(
                    callEndTime
                  )}`.underline.red
                );

                const callDuration = `${getFullISTDateTime(
                  callStartTime
                )} to ${getFullISTDateTime(callEndTime)}`;

                const callRecord = new callModel({
                  callStartTime,
                  callEndTime,
                  callDuration,
                  istStartTime: getFullISTDateTime(callStartTime),
                  istEndTime: getFullISTDateTime(callEndTime),
                  username,
                  email,
                  transcript,
                  agentType,
                });

                try {
                  await callRecord.save();
                  console.log(
                    `CallModel transcript saved to MongoDB at ${getFullISTDateTime(
                      new Date()
                    )} for agent: ${agentType}`.magenta
                  );
                } catch (error) {
                  console.error("Error saving callModel transcript:", error);
                }

                try {
                  await agentModel.updateOne(
                    { name: agentType },
                    {
                      $set: {
                        prompts: [{ role: "assistant", content: initialPrompt }],
                      },
                    },
                    { upsert: true }
                  );
                  console.log(
                    `Agent (${agentType}) initial prompt saved to MongoDB at ${getFullISTDateTime(
                      new Date()
                    )}`.magenta
                  );
                } catch (error) {
                  console.error("Error saving agent initial prompt:", error);
                }
              }
            } catch (err) {
              console.error(`Error processing WebSocket message: ${err.message}`.red);
            }
          });

          transcriptionService.on("utterance", async (text) => {
            if (marks.length > 0 && text?.length > 5 && isSpeaking) {
              console.log(
                `Twilio -> Interruption at ${formatISTTime(
                  new Date()
                )}, Clearing stream`.red
              );
              ws.send(
                JSON.stringify({
                  streamSid,
                  event: "clear",
                })
              );
              isSpeaking = false;
            }
          });

          transcriptionService.on("transcription", async (text) => {
            if (!text) return;
            
            while (isSpeaking) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            await new Promise(resolve => setTimeout(resolve, 2000));

            const now = new Date();
            console.log(
              `[${formatISTTime(
                now
              )}] Interaction ${interactionCount} - STT -> GPT: ${text}`.yellow
            );

            if (!transcript) transcript = [];

            transcript.push({
              user: text,
              gpt: "",
              timestamp: formatISTTime(now),
            });

            if (interactionCount === 2 && text.toLowerCase().includes("my name is")) {
              username = text.toLowerCase().replace("my name is", "").trim();
            }
            if (interactionCount === 3 && text.toLowerCase().includes("gmail")) {
              email = text.toLowerCase().replace(/\s/g, "") + "@gmail.com";
            }

            try {
              if (text.toLowerCase().includes("transfer") && text.toLowerCase().includes("call")) {
                ws.send(
                  JSON.stringify({
                    streamSid,
                    event: "clear",
                  })
                ); // Clear pending audio
                const transferPrompt = "Sure, I’m transferring you to a human agent now. • Whom would you like to speak to?";
                ttsService.generate(
                  {
                    partialResponseIndex: null,
                    partialResponse: transferPrompt,
                  },
                  interactionCount
                );
                isSpeaking = true;
                await gptService.completion(
                  "User requested to transfer the call. Ask for the name of the agent to transfer to.",
                  interactionCount,
                  "system",
                  "system"
                );
              } else {
                await gptService.completion(text, interactionCount);
              }
              interactionCount += 1;
              errorCount = 0; // Reset error count on successful input
            } catch (err) {
              console.error(`Error in GPT completion: ${err.message}`.red);
              errorCount++;
              if (errorCount > 3) {
                ws.send(
                  JSON.stringify({
                    streamSid,
                    event: "clear",
                  })
                ); // Clear stream to prevent overload
                const errorMessage = "I'm having trouble. • Would you like to transfer to a human agent?";
                ttsService.generate(
                  {
                    partialResponseIndex: null,
                    partialResponse: errorMessage,
                  },
                  interactionCount
                );
                isSpeaking = true;
                errorCount = 0;
              } else {
                const errorMessage = "Sorry, I hit a snag. • Let's try again.";
                ttsService.generate(
                  {
                    partialResponseIndex: null,
                    partialResponse: errorMessage,
                  },
                  interactionCount
                );
                isSpeaking = true;
              }
            }
          });

          gptService.on("gptreply", async (gptReply, icount) => {
            try {
              while (isSpeaking) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              await new Promise(resolve => setTimeout(resolve, 2000));

              const now = new Date();
              console.log(
                `[${formatISTTime(now)}] Interaction ${icount}: GPT -> TTS: ${
                  gptReply.partialResponse
                }`.green
              );

              if (transcript[icount]) {
                transcript[icount].gpt = gptReply.partialResponse;
                transcript[icount].timestamp =
                  transcript[icount].timestamp || formatISTTime(now);
              } else {
                transcript.push({
                  user: "",
                  gpt: gptReply.partialResponse,
                  timestamp: formatISTTime(now),
                });
              }

              ttsService.generate(gptReply, icount);
              isSpeaking = true;
            } catch (err) {
              console.error(`Error in gptreply handler: ${err.message}`.red);
            }
          });

          ttsService.on("speech", (responseIndex, audio, label, icount) => {
            console.log(
              `[${formatISTTime(
                new Date()
              )}] Interaction ${icount}: TTS -> TWILIO: ${label}`.blue
            );
            streamService.buffer(responseIndex, audio);
          });

          streamService.on("audiosent", (markLabel) => {
            marks.push(markLabel);
          });
        }
      } catch (err) {
        console.error(`Error processing WebSocket message: ${err.message}`.red);
      }
    });
  } catch (err) {
    console.error(`Error in callConnection: ${err.message}`.red);
    ws.close(1011, "Internal server error");
  }
};

// export callModel controller
module.exports = {
  getCall,
  createCall,
  updateCall,
  deleteCall,
  incomingCall,
  callConnection,
};