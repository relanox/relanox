package schema

import (
	"encoding/json"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/relanox/relanox/internal/model"
)

type Metadata struct{ ent.Schema }

func (Metadata) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_metadata"}}
}

func (Metadata) Fields() []ent.Field {
	return []ent.Field{field.String("id"), field.Int("format"), field.Int64("serial").Default(0), field.String("next_work").Default("dispatch")}
}

type Conversation struct{ ent.Schema }

func (Conversation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_conversations"}}
}

func (Conversation) Fields() []ent.Field {
	return []ent.Field{field.String("id"), field.Bool("active"), field.String("endpoint_id"), field.String("agent"), field.JSON("record", model.ConversationRecord{})}
}

func (Conversation) Indexes() []ent.Index { return []ent.Index{index.Fields("active", "endpoint_id")} }

type Inbound struct{ ent.Schema }

func (Inbound) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_inbounds"}}
}

func (Inbound) Fields() []ent.Field {
	return []ent.Field{
		field.String("id"), field.String("channel"), field.String("account_id"), field.String("event_id"), field.String("channel_id"), field.String("endpoint_id"),
		field.Int64("accepted_at"), field.String("status"), field.Int64("version"), field.Int64("due_at"), field.Int64("lease_expires_at").Optional().Nillable(),
		field.Bool("ready"), field.Bool("filtered"), field.Bool("redacted"), field.String("final_delivery_id").Optional(), field.JSON("record", model.InboundRecord{}),
	}
}

func (Inbound) Indexes() []ent.Index {
	return []ent.Index{index.Fields("channel", "account_id", "event_id").Unique(), index.Fields("status", "due_at", "accepted_at"), index.Fields("lease_expires_at"), index.Fields("channel_id", "ready", "accepted_at"), index.Fields("endpoint_id", "accepted_at"), index.Fields("redacted", "accepted_at")}
}

func (Inbound) Edges() []ent.Edge {
	return []ent.Edge{edge.To("assets", MediaAsset.Type).StorageKey(edge.Table("relanox_go_inbound_assets"))}
}

type Outbound struct{ ent.Schema }

func (Outbound) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_outbounds"}}
}

func (Outbound) Fields() []ent.Field {
	return []ent.Field{
		field.String("id"), field.String("channel"), field.String("channel_id"), field.String("account_id"), field.String("endpoint_id"), field.String("message_id"), field.String("digest"),
		field.Int64("sequence").Immutable().Unique(),
		field.Int64("created_at"), field.String("status"), field.Int64("version"), field.Int64("due_at"), field.Int64("lease_expires_at").Optional().Nillable(),
		field.Bool("redacted"), field.JSON("record", model.OutboundRecord{}),
	}
}

func (Outbound) Indexes() []ent.Index {
	return []ent.Index{index.Fields("channel_id", "message_id").Unique(), index.Fields("status", "due_at", "sequence"), index.Fields("lease_expires_at"), index.Fields("channel_id", "status", "sequence"), index.Fields("endpoint_id", "created_at"), index.Fields("redacted", "created_at")}
}

func (Outbound) Edges() []ent.Edge {
	return []ent.Edge{edge.To("assets", MediaAsset.Type).StorageKey(edge.Table("relanox_go_outbound_assets"))}
}

type MediaAsset struct{ ent.Schema }

func (MediaAsset) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_media"}}
}

func (MediaAsset) Fields() []ent.Field {
	return []ent.Field{
		field.String("id"), field.String("channel_id"), field.Int64("size"), field.Int64("created_at"), field.Bool("staged"), field.Bool("retained"),
		field.String("preview_id").Optional(), field.JSON("reference", model.MediaReference{}), field.Bytes("data").Optional(),
	}
}

func (MediaAsset) Indexes() []ent.Index {
	return []ent.Index{index.Fields("channel_id", "staged"), index.Fields("retained", "created_at"), index.Fields("preview_id")}
}

func (MediaAsset) Edges() []ent.Edge {
	return []ent.Edge{edge.From("inbounds", Inbound.Type).Ref("assets"), edge.From("outbounds", Outbound.Type).Ref("assets")}
}

type State struct{ ent.Schema }

func (State) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "relanox_go_state"}}
}

func (State) Fields() []ent.Field {
	return []ent.Field{field.String("id"), field.String("component"), field.String("owner_id"), field.String("key"), field.Int64("version"), field.Bool("live"), field.Int64("expires_at").Optional().Nillable(), field.JSON("value", json.RawMessage{}).Optional()}
}

func (State) Indexes() []ent.Index {
	return []ent.Index{index.Fields("component", "owner_id", "key").Unique(), index.Fields("component", "owner_id", "live", "expires_at")}
}
