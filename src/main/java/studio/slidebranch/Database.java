package studio.slidebranch;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

final class Database implements AutoCloseable {
    private final Connection connection;

    Database(Path file) throws SQLException, IOException {
        connection = DriverManager.getConnection("jdbc:sqlite:" + file);
        try (var statement = connection.createStatement();
             var schema = Objects.requireNonNull(Database.class.getResourceAsStream("/schema.sql"))) {
            statement.execute("PRAGMA foreign_keys = ON");
            statement.execute("PRAGMA journal_mode = WAL");
            statement.execute("PRAGMA busy_timeout = 5000");
            int version;
            try (var result = statement.executeQuery("PRAGMA user_version")) {
                version = result.getInt(1);
            }
            if (version > 2) {
                throw new SQLException("Unsupported database version: " + version);
            }
            if (version < 2) {
                connection.setAutoCommit(false);
                try {
                    if (version == 0) {
                        runScript(statement, schema);
                        migrate(statement, "/boards.sql");
                    }
                    migrate(statement, "/page_versions.sql");
                    statement.execute("PRAGMA user_version=2");
                    connection.commit();
                } catch (SQLException | IOException failure) {
                    connection.rollback();
                    throw failure;
                } finally {
                    connection.setAutoCommit(true);
                }
            }
        }
    }

    private static void migrate(Statement statement, String resource) throws SQLException, IOException {
        try (var script = Objects.requireNonNull(Database.class.getResourceAsStream(resource))) {
            runScript(statement, script);
        }
    }

    private static void runScript(Statement statement, java.io.InputStream script) throws SQLException, IOException {
        String text = new String(script.readAllBytes(), StandardCharsets.UTF_8);
        for (String sql : text.split("\\R--\\R")) {
            statement.execute(sql);
        }
    }

    interface Transaction<T> {
        T run() throws Exception;
    }

    synchronized <T> T transaction(Transaction<T> work) throws Exception {
        connection.setAutoCommit(false);
        try {
            T result = work.run();
            connection.commit();
            return result;
        } catch (Exception failure) {
            connection.rollback();
            throw failure;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    synchronized List<Map<String, Object>> rows(String sql, Object... values) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            bind(statement, values);
            try (var result = statement.executeQuery()) {
                var metadata = result.getMetaData();
                List<Map<String, Object>> rows = new ArrayList<>();
                while (result.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int index = 1; index <= metadata.getColumnCount(); index++) {
                        row.put(metadata.getColumnLabel(index), result.getObject(index));
                    }
                    rows.add(row);
                }
                return rows;
            }
        }
    }

    Map<String, Object> one(String sql, Object... values) throws SQLException {
        var rows = rows(sql, values);
        if (rows.isEmpty()) {
            throw new Problem(404, "记录不存在");
        }
        return rows.getFirst();
    }

    synchronized int execute(String sql, Object... values) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            bind(statement, values);
            return statement.executeUpdate();
        }
    }

    synchronized long insert(String sql, Object... values) throws SQLException {
        try (var statement = connection.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {
            bind(statement, values);
            statement.executeUpdate();
            try (var keys = statement.getGeneratedKeys()) {
                if (keys.next()) {
                    return keys.getLong(1);
                }
                throw new SQLException("Insert did not return an ID");
            }
        }
    }

    static long number(Map<String, Object> row, String field) {
        return ((Number) row.get(field)).longValue();
    }

    private static void bind(java.sql.PreparedStatement statement, Object[] values) throws SQLException {
        for (int index = 0; index < values.length; index++) {
            statement.setObject(index + 1, values[index]);
        }
    }

    @Override
    public synchronized void close() throws SQLException {
        connection.close();
    }
}
